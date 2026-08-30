#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_INA219.h>
#include <U8g2lib.h>
#include <Keypad.h>

// -----------------------------------------
// CREDENCIALES DE RED Y BROKER LOCAL
// -----------------------------------------
const char* ssid = "ALLAN 8143";
const char* password = "12345678";
const char* mqtt_server = "192.168.137.1";
const int mqtt_port = 1883;

WiFiClient espClient;
PubSubClient mqttClient(espClient);

// -----------------------------------------
// DEFINICIÓN DE PINES
// -----------------------------------------
#define PIN_PROXIMIDAD 35 // Sensor óptico de gotas
#define PIN_BUZZER 15

// Driver TB6612FNG
// *** IMPORTANTE ***
// Si tu módulo ESP32 es un WROVER (con PSRAM), los GPIO16 y GPIO17
// están usados internamente por la memoria PSRAM y NO sirven como
// GPIO normales. Si tu motor no gira y ya descartaste el cableado,
// cambia estos dos a otros pines libres (ej. 2, 4 sigue libre igual).
#define MOTOR_PWMA 17
#define MOTOR_AIN1 16
#define MOTOR_AIN2 4

// Config del canal PWM (ESP32 Arduino core 2.x, API por canal)
const int PWM_CHANNEL = 0;      // canal LEDC 0..15
const int PWM_FREQ = 5000;      // 5 kHz, típico para drivers de motor DC
const int PWM_RES  = 8;         // 8 bits -> 0-255
uint8_t velocidadMotor = 255;   // 255 = potencia máxima. Bájalo si quieres suavizar arranque.

// --- TECLADO MATRICIAL 4x4 ---
const byte ROWS = 4; 
const byte COLS = 4; 
char hexaKeys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {32, 33, 25, 26}; 
byte colPins[COLS] = {27, 14, 12, 13}; 
Keypad customKeypad = Keypad(makeKeymap(hexaKeys), rowPins, colPins, ROWS, COLS);

U8G2_ST7920_128X64_1_SW_SPI u8g2(U8G2_R0, 18, 23, 5, 22);

// -----------------------------------------
// VARIABLES GLOBALES
// -----------------------------------------
Adafruit_INA219 ina219;
bool ina219_ok = false;
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

volatile uint32_t contadorGotas = 0;
volatile uint32_t gotasTotales = 0; 
volatile unsigned long ultimoTiempoDeteccion = 0;
volatile unsigned long ultimaGotaTiempo = 0; 
const unsigned long tiempoDebounceGoteo = 40; 

bool enDosificacion = false;
bool obstruccion = false;
bool finalizado = false;
int volumen_ml = 0;
int gotas_setpoint = 0;
bool es_hora = false; 
uint32_t tiempo_inicio = 0; 
uint32_t tiempo_inicio_motor = 0; 
String espID = "ESP_103"; 

bool actualizarPantalla = true; 
int pantallaActual = 0; 
int filaActual = 0;         
String volumenStr = "";
String gotasStr = "";
int opcionTiempo = 0;       
int opcionAccion = 0;       
int opcionRun = 0;          

const float UMBRAL_OBSTRUCCION = 950.0; 

// -----------------------------------------
// FUNCIONES AUXILIARES DE MOTOR (PWM real)
// -----------------------------------------
void motorAdelante(uint8_t duty) {
    digitalWrite(MOTOR_AIN1, HIGH);
    digitalWrite(MOTOR_AIN2, LOW);
    ledcWrite(PWM_CHANNEL, duty);
}

void motorDetener() {
    digitalWrite(MOTOR_AIN1, LOW);
    digitalWrite(MOTOR_AIN2, LOW);
    ledcWrite(PWM_CHANNEL, 0);
}

// Prueba automática al encender: gira el motor 2s a máxima potencia
// para verificar cableado SIN necesidad de usar el teclado/menú.
void testMotorInicial() {
    Serial.println("=== TEST DE MOTOR AL ARRANQUE ===");
    Serial.printf("AIN1=%d AIN2=%d PWMA=%d (pines)\n", MOTOR_AIN1, MOTOR_AIN2, MOTOR_PWMA);
    motorAdelante(255);
    uint32_t t0 = millis();
    while (millis() - t0 < 2000) {
        if (ina219_ok) {
            float mA = ina219.getCurrent_mA();
            Serial.printf("  Corriente motor: %.1f mA\n", mA);
        } else {
            Serial.println("  (INA219 no disponible, no se puede leer corriente)");
        }
        delay(300);
    }
    motorDetener();
    Serial.println("=== FIN TEST DE MOTOR ===");
    Serial.println("Si el motor NO giro: revisa VM del TB6612, GND comun, y que AIN1/PWMA");
    Serial.println("realmente cambien de voltaje (midelo con multimetro). Si es modulo");
    Serial.println("WROVER, GPIO16/17 pueden estar ocupados por la PSRAM: cambia de pines.");
}

// -----------------------------------------
// ISR: DETECCIÓN DE GOTAS
// -----------------------------------------
void IRAM_ATTR isrProximidad() {
    unsigned long tiempoActual = millis();
    if (tiempoActual - ultimoTiempoDeteccion > tiempoDebounceGoteo) {
        portENTER_CRITICAL_ISR(&mux);
        contadorGotas++;
        gotasTotales++; 
        ultimaGotaTiempo = tiempoActual;
        portEXIT_CRITICAL_ISR(&mux);
        ultimoTiempoDeteccion = tiempoActual;
    }
}

// -----------------------------------------
// TAREA DE CONTROL DEL MOTOR Y SEGURIDAD
// -----------------------------------------
void TaskControl(void *pvParameters) {
    uint32_t ultimoDebug = 0;

    for (;;) {
        if (enDosificacion && !obstruccion && !finalizado) {
            // Activar marcha del motor (PWM real, no solo digitalWrite)
            motorAdelante(velocidadMotor);

            // Debug periódico de estado de pines/corriente (cada 1s)
            if (millis() - ultimoDebug > 1000) {
                ultimoDebug = millis();
                Serial.printf("[MOTOR] AIN1=%d AIN2=%d PWMduty=%d gotas=%u\n",
                              digitalRead(MOTOR_AIN1), digitalRead(MOTOR_AIN2),
                              velocidadMotor, gotasTotales);
            }

            // Monitoreo opcional de corriente INA219 (tras 2 segundos de arranque)
            if (ina219_ok && (millis() - tiempo_inicio_motor > 2000)) {
                float corriente_mA = ina219.getCurrent_mA();
                if (corriente_mA > UMBRAL_OBSTRUCCION) { 
                    obstruccion = true; 
                    enDosificacion = false;
                    motorDetener();
                    Serial.print(">>> DETENIDA POR CORRIENTE: ");
                    Serial.println(corriente_mA);
                }
            }

            // Meta de volumen alcanzada
            uint32_t gotasMeta = volumen_ml * 20; 
            if (gotasMeta > 0 && gotasTotales >= gotasMeta) {
                finalizado = true;
                enDosificacion = false;
                motorDetener();
                Serial.println(">>> INFUSION COMPLETADA POR META DE GOTAS");
            }
        } else {
            // Apagado del motor
            motorDetener();
        }
        vTaskDelay(pdMS_TO_TICKS(50)); 
    }
}

// -----------------------------------------
// TAREA DE INTERFAZ
// -----------------------------------------
void TaskUI(void *pvParameters) {
    uint32_t ultimoRefresco = 0; 

    for (;;) {
        char customKey = customKeypad.getKey();
        
        if (customKey) {
            actualizarPantalla = true;

            // Atajo de diagnostico: mantener presionada 'A' en pantalla principal
            // y luego pulsar '0' hace un test de motor de 2s sin iniciar dosificacion.
            if (pantallaActual == 0 && customKey == '0' && filaActual == 3) {
                testMotorInicial();
            }

            if (pantallaActual == 0) {
                if (customKey == 'A') { if (filaActual > 0) filaActual--; } 
                else if (customKey == 'B') { if (filaActual < 3) filaActual++; } 
                else if (customKey == 'C') {
                    if (filaActual == 3) {
                        if (opcionAccion == 0) { // INICIAR
                            volumen_ml = volumenStr.toInt();
                            gotas_setpoint = gotasStr.toInt();
                            es_hora = (opcionTiempo == 1);
                            
                            if (volumen_ml > 0) {
                                tiempo_inicio = millis(); 
                                tiempo_inicio_motor = millis(); 
                                ultimaGotaTiempo = millis(); 
                                gotasTotales = 0; 

                                obstruccion = false;
                                finalizado = false;
                                enDosificacion = true;
                                pantallaActual = 1;
                                opcionRun = 0; 
                                Serial.println(">>> INFUSION INICIADA");
                            } else {
                                Serial.println(">>> ERROR: volumen_ml es 0, no se inicia. Verifica que hayas tecleado el volumen.");
                            }
                        } else if (opcionAccion == 1) { 
                            volumenStr = ""; gotasStr = "";
                            opcionTiempo = 0; filaActual = 0;
                        }
                    }
                } 
                else if (customKey == 'D') {
                    if (filaActual == 0 && volumenStr.length() > 0) volumenStr.remove(volumenStr.length() - 1);
                    else if (filaActual == 1 && gotasStr.length() > 0) gotasStr.remove(gotasStr.length() - 1);
                } 
                else if (customKey == '*') {
                    if (filaActual == 2) opcionTiempo = 0;
                    else if (filaActual == 3) opcionAccion = 0;
                } 
                else if (customKey == '#') {
                    if (filaActual == 2) opcionTiempo = 1;
                    else if (filaActual == 3) opcionAccion = 1;
                } 
                else if (isDigit(customKey) && !(filaActual == 3 && customKey == '0')) {
                    if (filaActual == 0) volumenStr += customKey;
                    else if (filaActual == 1) gotasStr += customKey;
                }
            } else if (pantallaActual == 1) {
                if (customKey == '*') { if (opcionRun > 0) opcionRun--; } 
                else if (customKey == '#') { if (opcionRun < 2) opcionRun++; } 
                else if (customKey == 'C') {
                    if (opcionRun == 0) { // PARAR
                        enDosificacion = false;
                        Serial.println(">>> PAUSA");
                    } else if (opcionRun == 1) { // REINICIAR
                        enDosificacion = true;
                        obstruccion = false;
                        tiempo_inicio_motor = millis(); 
                        ultimaGotaTiempo = millis(); 
                        Serial.println(">>> REANUDAR");
                    } else if (opcionRun == 2) { // TERMINAR
                        enDosificacion = false;
                        finalizado = true;
                        pantallaActual = 0; 
                        filaActual = 0;
                        Serial.println(">>> TERMINAR");
                    }
                }
            }
        }

        if (pantallaActual == 1 && (millis() - ultimoRefresco >= 500)) {
            actualizarPantalla = true;
            ultimoRefresco = millis();
        }

        if (actualizarPantalla) {
            u8g2.firstPage();
            do {
                u8g2.setFont(u8g2_font_6x10_tr); 
                
                if (pantallaActual == 0) {
                    if (filaActual == 0) u8g2.drawStr(0, 12, ">"); 
                    u8g2.drawStr(8, 12, "Volumen(ml):");
                    u8g2.drawStr(82, 12, volumenStr.length() > 0 ? volumenStr.c_str() : "_");

                    if (filaActual == 1) u8g2.drawStr(0, 28, ">");
                    u8g2.drawStr(8, 28, "Gotas:");
                    u8g2.drawStr(50, 28, gotasStr.length() > 0 ? gotasStr.c_str() : "_");

                    if (filaActual == 2) u8g2.drawStr(0, 44, ">");
                    if (opcionTiempo == 0) u8g2.drawStr(12, 44, ">MIN< HORA");
                    else u8g2.drawStr(12, 44, " MIN >HORA<");

                    if (filaActual == 3) u8g2.drawStr(0, 60, ">");
                    if (opcionAccion == 0) u8g2.drawStr(12, 60, ">INICIAR< BORRAR");
                    else u8g2.drawStr(12, 60, " INICIAR >BORRAR<");

                } else if (pantallaActual == 1) {
                    u8g2.drawStr(0, 15, obstruccion ? "ESTADO: OBSTRUIDO" : (enDosificacion ? "ESTADO: DOSIFICANDO" : "ESTADO: PAUSADO"));
                    
                    u8g2.drawStr(0, 30, "Gotas: ");
                    char gBuf[16];
                    sprintf(gBuf, "%u / %u", gotasTotales, (volumen_ml * 20));
                    u8g2.drawStr(45, 30, gBuf);

                    int vol_infundido = gotasTotales / 20; 
                    int vol_restante = volumen_ml - vol_infundido;
                    if (vol_restante < 0) vol_restante = 0;
                    
                    char volBuf[20];
                    sprintf(volBuf, "Vol.Rest: %d ml", vol_restante);
                    u8g2.drawStr(0, 43, volBuf);

                    u8g2.setFont(u8g2_font_5x8_tr); 
                    if (opcionRun == 0) u8g2.drawStr(0, 58, ">PARAR< REINICIAR TERM");
                    else if (opcionRun == 1) u8g2.drawStr(0, 58, "PARAR >REINICIAR< TERM");
                    else if (opcionRun == 2) u8g2.drawStr(0, 58, "PARAR REINICIAR >TERM<");
                }
            } while ( u8g2.nextPage() );
            actualizarPantalla = false; 
        }
        vTaskDelay(pdMS_TO_TICKS(50)); 
    }
}

// -----------------------------------------
// TAREA DE TELEMETRÍA (MQTT Local)
// -----------------------------------------
void TaskTelemetry(void *pvParameters) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    mqttClient.setServer(mqtt_server, mqtt_port);
    
    for (;;) {
        if (WiFi.status() == WL_CONNECTED) {
            if (!mqttClient.connected()) {
                mqttClient.connect(espID.c_str());
            } else {
                mqttClient.loop();

                uint32_t tiempoRestante_ms = 0;
                int gotasRestantes = (volumen_ml * 20) - gotasTotales;
                if (gotasRestantes > 0 && gotas_setpoint > 0) {
                    float gotasPorSegundo = es_hora ? (gotas_setpoint / 3600.0) : (gotas_setpoint / 60.0);
                    tiempoRestante_ms = (uint32_t)((gotasRestantes / gotasPorSegundo) * 1000.0);
                }
                
                int h = (tiempoRestante_ms / 3600000);
                int m = (tiempoRestante_ms % 3600000) / 60000;
                int s = (tiempoRestante_ms % 60000) / 1000;
                char t_str[9];
                sprintf(t_str, "%02d:%02d:%02d", h, m, s); 

                String jsonOutput = "{";
                jsonOutput += "\"ID\":\"" + espID + "\",";
                jsonOutput += "\"O\":" + String(obstruccion ? 1 : 0) + ",";
                jsonOutput += "\"T\":\"" + String(t_str) + "\",";
                jsonOutput += "\"A\":" + String(finalizado ? 1 : 0) + ",";
                jsonOutput += "\"G\":" + String(gotas_setpoint) + ",";
                jsonOutput += "\"V\":" + String(volumen_ml) + ",";
                jsonOutput += "\"H\":" + String(es_hora ? 1 : 0) + ",";
                jsonOutput += "\"M\":" + String(!es_hora ? 1 : 0) + ",";
                jsonOutput += "\"enEjecucion\":" + String((enDosificacion || obstruccion) ? 1 : 0);
                jsonOutput += "}";

                mqttClient.publish("hospital/telemetria", jsonOutput.c_str());
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1000)); 
    }
}

// -----------------------------------------
// SETUP PRINCIPAL
// -----------------------------------------
void setup() {
    Serial.begin(115200);
    delay(500); // da tiempo a abrir el monitor serial y ver el test de motor

    // Pines de teclado
    pinMode(12, INPUT_PULLUP);
    pinMode(13, INPUT_PULLUP);
    pinMode(14, INPUT_PULLUP);
    pinMode(27, INPUT_PULLUP);

    u8g2.setBusClock(1000000);
    u8g2.begin();

    // Sensor de gotas
    pinMode(PIN_PROXIMIDAD, INPUT);
    attachInterrupt(digitalPinToInterrupt(PIN_PROXIMIDAD), isrProximidad, FALLING);

    // Pines del driver TB6612FNG
    pinMode(MOTOR_AIN1, OUTPUT);
    pinMode(MOTOR_AIN2, OUTPUT);
    digitalWrite(MOTOR_AIN1, LOW);
    digitalWrite(MOTOR_AIN2, LOW);

    // PWMA como canal PWM real (ESP32 Arduino core 2.x, API por canal).
    // Si en el futuro migras a core >= 3.0, cambia esto por:
    //   ledcAttach(MOTOR_PWMA, PWM_FREQ, PWM_RES);
    // y usa ledcWrite(MOTOR_PWMA, duty) en vez de ledcWrite(PWM_CHANNEL, duty).
    ledcSetup(PWM_CHANNEL, PWM_FREQ, PWM_RES);
    ledcAttachPin(MOTOR_PWMA, PWM_CHANNEL);
    ledcWrite(PWM_CHANNEL, 0);

    // Bus I2C con timeout seguro
    Wire.begin(21, 19); 
    Wire.setTimeOut(25);
    if (ina219.begin()) {
        ina219_ok = true;
        Serial.println("INA219 Detectado");
    } else {
        Serial.println("INA219 no detectado (Omitido)");
    }

    // --- TEST AUTOMATICO DE MOTOR AL ENCENDER ---
    // Gira el motor 2s de una vez, sin necesidad de tocar el teclado.
    // Comenta esta linea cuando ya confirmes que el motor gira bien.
    testMotorInicial();

    // Tareas FreeRTOS
    xTaskCreatePinnedToCore(TaskControl, "Control_Motor", 4096, NULL, 3, NULL, 1); 
    xTaskCreatePinnedToCore(TaskUI, "Pantalla_UI", 4096, NULL, 2, NULL, 1);      
    xTaskCreatePinnedToCore(TaskTelemetry, "MQTT_Tx", 8192, NULL, 1, NULL, 0);   
}

void loop() {
    vTaskDelete(NULL);
}
