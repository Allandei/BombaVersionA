console.log(">>> [1/3] Iniciando Servidor Central...");

const fs = require('fs');
const path = require('path');
const net = require('net');
const aedes = require('aedes')();
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');

// 1. Cargar clave y conectar a Firebase
const rutaKey = path.join(__dirname, 'firebase-key.json');
if (!fs.existsSync(rutaKey)) {
  console.error(">>> ERROR: No se encontró 'firebase-key.json' en DASHBOARD.");
  process.exit(1);
}

const serviceAccount = require(rutaKey);

try {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://bomba-de-infusion-3009c-default-rtdb.firebaseio.com"
  });
  console.log(">>> [2/3] Firebase inicializado correctamente.");
} catch (e) {
  console.error(">>> Error en Firebase:", e.message);
  process.exit(1);
}

const db = getDatabase();
const ref = db.ref('bombas');

// 2. Levantar el Broker MQTT Local en el puerto 1883
const PORT = 1883;
const server = net.createServer(aedes.handle);

server.listen(PORT, '0.0.0.0', function () {
  console.log(`>>> [3/3] ¡BROKER MQTT LOCAL ACTIVO en el puerto ${PORT}!`);
  console.log(">>> Esperando conexión del ESP32...\n");
});

server.on('error', function (err) {
  console.error('>>> Error en el servidor TCP/MQTT:', err.message);
});

// 3. Notificar conexiones y desconexiones
aedes.on('client', function (client) {
  console.log(`>>> [DISPOSITIVO CONECTADO]: ${client.id}`);
});

aedes.on('clientDisconnect', function (client) {
  console.log(`>>> [DISPOSITIVO DESCONECTADO]: ${client.id}`);
});

// 4. Capturar telemetría y enviar a Firebase
aedes.on('publish', async function (packet, client) {
  if (packet.topic === 'hospital/telemetria') {
    const msgStr = packet.payload.toString();
    console.log(">>> [PAQUETE RECIBIDO DEL ESP32]:", msgStr);

    try {
      const data = JSON.parse(msgStr);
      if (!data.ID) return;

      const snapshot = await ref.child(data.ID).once('value');
      const existing = snapshot.val();

      let fechaReg, horaReg;
      const ahora = new Date();

      if (data.enEjecucion === 1) {
        if (!existing || !existing.horaInicio || existing.acabado === 1 || existing.enEjecucion === 0) {
          fechaReg = ahora.toLocaleDateString('es-EC');
          horaReg  = ahora.toLocaleTimeString('es-EC');
        } else {
          fechaReg = existing.fecha;
          horaReg  = existing.horaInicio;
        }
      } else {
        fechaReg = existing ? existing.fecha : "-";
        horaReg  = existing ? existing.horaInicio : "-";
      }

      await ref.child(data.ID).update({
        obstruccion: data.O ?? 0,
        tiempoRestante: data.T ?? "00:00:00",
        acabado: data.A ?? 0,
        gotas: data.G ?? 0,
        esHora: data.H === 1,
        volumen: data.V ?? 100,
        enEjecucion: data.enEjecucion ?? 0,
        fecha: fechaReg,
        horaInicio: horaReg,
        ts: Date.now(),
        ultimaActualizacion: ServerValue.TIMESTAMP
      });

      console.log(`[Firebase OK] ${data.ID} actualizado en la base de datos.`);
    } catch (error) {
      console.error("Error al procesar JSON o guardar en Firebase:", error.message);
    }
  }
});