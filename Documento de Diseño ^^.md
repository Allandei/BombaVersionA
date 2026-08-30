

<!-- Start of picture text -->
Alarmas Acusticas_ > Personal de Enfermeria<br>Parametros/Inicio<br>Bomba de Infusion Alerta MQTT/JSON———>|_ Estacion Central Node.js<br>ESP32 | Regulacion/Flujo, ) ~<br>Linea de Infusion / Paciente<br>Feedback Optico/FSR<br><!-- End of picture text -->



<!-- Start of picture text -->
Core 0: IoT MQTT & GLCD<br>Control PWM / DIR-p) Driver TBGG42FNG Alimentacion 12V-—| Motor DC Peristaltico }--Consumo de Corriente<br>Sensor INA219<br>7 is, Bus 12C (Monitoreo<br>Sensor Gotas IR + LM358. -—Interrupcionpei Digital i)rrient<br><!-- End of picture text -->



<!-- Start of picture text -->
Energizacién<br>+<br>Autotest OK (RTOS Activo)<br>+<br>ia<br>Iniciar (Carga Pardametros)ft Vol == 0 (Fin Tratamiento)|<br>INA219 > Umbral Corriente Corriente Normal (< 5s) / Reset Mantal /<br>“a Inyeccidén Bolo Intervencién<br>Fallo Critico / Desconexién<br>MQTT<br>Oclusi6n Persiste (> 5s) |<br>Oa<br><!-- End of picture text -->



<!-- Start of picture text -->
Personal de Enfermeria Par Optico IR (Sensor Gotas)<br>1. Parametros e Inicio 2. Pulso Ruidoso<br>Core 0: IoT & HMI | Trigger Schmitt (LM358) |<br>Despliegue Local 9. Tramas JSON / MQTT Monitoreo Remoto 3. Interrupcion Digital<br>Pantalla GLCD 128x64 Broker Mosquitto Core 1: Lazo de Control<br>10. WebSockets 5. PWM / Direccién<br>Dashboard / Servidor A<br>Central Driver TB6612FNG<br>6. Voltaje12V 4. Lectura Corriente / 12C<br>Motor DC Peristaltico<br>7. Consumo de Corriente<br>Sensor INA219<br><!-- End of picture text -->

Nombre: Allan Muguerza 

## **7. Alternativas de Diseño** 

|**Criterio de**<br>**Selección**|**Alternatva Evaluada**|**Solución**<br>**Implementada**|**Justfcación Técnica**|
|---|---|---|---|
|**Monitoreo de**<br>**Flujo**|**Balanzas o celdas de carga**<br>**mecánicas.**|**Sensor**<br>**óptco**<br>**infrarrojo con Trigger**<br>**Schmit.**|**Evita descalibraciones por movimiento del**<br>**soporte y valida gota a gota sin contacto fsico con**<br>**el fuido.**|
|**Detección de**<br>**Oclusión**|**Sensor de fuerza resistvo**<br>**(FSR) montado en la**<br>**manguera.**|**Sensor de corriente y**<br>**voltaje INA219 en la**<br>**línea del motor.**|**Mide directamente el sobreesfuerzo eléctrico del**<br>**motor ante cualquier atasco u obstrucción,**<br>**evitando calibraciones mecánicas complejas sobre**<br>**la manguera.**|
|**Etapa de Potencia**|**Circuitos discretos con**<br>**transistores o puentes H**<br>**convencionales.**|**Driver compacto**<br>**TB6612FNG controlado**<br>**por PWM desde el**<br>**ESP32.**|**Ofrece alta efciencia energétca, bajo**<br>**calentamiento y control directo de giro y**<br>**velocidad con bajo consumo de pines.**|



## **8. Plan de Test y Validación** 

**Test 1:** Programar tasas de 50 ml/h y 250 ml/h. Medir el volumen real recolectado en una probeta graduada tras una hora. **Criterio de Aceptación:** El error acumulado entre las gotas validadas ópticamente por el sensor IR, la tasa calculada por PWM y el volumen real medido debe ser inferior al 2%. 

**Test 2:** Respuesta ante Oclusiones (Protocolo Escalonado): Obstruir mecánicamente la manguera de salida en marcha activa. **Criterio de Aceptación:** Al superar el umbral de corriente en el sensor INA219 a través del bus I2C, el zumbador emite un pitido intermitente por un máximo de 5 segundos. Si el bloqueo persiste, el motor se detiene inmediatamente apagando el driver TB6612FNG y despacha la alerta MQTT en menos de 500 ms. 

**Test 3:** Concurrencia bajo Carga Temporal (RTOS): Desconectar el Broker MQTT abruptamente mientras la pantalla se actualiza o se inyecta un bolo. _Criterio de Aceptación:_ Las señales PWM enviadas por el Core 1 al driver TB6612FNG no deben presentar fluctuaciones ni congelamientos, demostrando el aislamiento total de tareas críticas frente a las secundarias. 

## **9. Consideraciones Éticas y de Seguridad** 

**Impacto Social:** La democratización de tecnologías médicas con bajo coste de hardware (USD 63.00 estimado) abre el acceso a la salud pública de precisión en entornos de atención rural e instituciones de docencia médica. **Riesgos Éticos:** Una pérdida de conectividad Wi-Fi o la saturación del servidor Node.js podría inducir una falsa sensación de control remoto en el personal clínico, descuidando la atención presencial. Errores de firmware arriesgan incidentes graves por subdosificación o sobredosificación. 

# Nombre: Allan Muguerza 

**Estrategias de Mitigación:** 1. _Prioridad Local Absoluta:_ El hardware prioriza de manera autónoma las alarmas acústicas y los paros de emergencia locales, operando de forma 100% segura, aunque la red de telemetría IoT colapse por completo. 2. _Fail-Safe Eléctrico:_ Desacoplamiento de tierras y fuentes de alimentación entre la lógica digital de 3.3V y la etapa de potencia de 12V del driver TB6612FNG, incorporando protección contra sobrecorriente por hardware mediante el sensor INA219. 

