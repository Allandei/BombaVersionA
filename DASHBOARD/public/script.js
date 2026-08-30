const firebaseConfig = {
    databaseURL: "https://bomba-de-infusion-3009c-default-rtdb.firebaseio.com"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const database = firebase.database();

let colaAlertas = [];
let reproduciendo = false;
let audioDesbloqueado = false;
let estadosAnteriores = {}; 

// Persistencia en LocalStorage
let cubiculosAsignados = JSON.parse(localStorage.getItem('cubiculosAsignados') || '{}'); 
let cubiculosValidados = JSON.parse(localStorage.getItem('cubiculosValidados') || '{}'); 
let filtroEstadoActual = 'TODOS';
let historialEventos = [];

function guardarEstadoCubiculos() {
    localStorage.setItem('cubiculosAsignados', JSON.stringify(cubiculosAsignados));
    localStorage.setItem('cubiculosValidados', JSON.stringify(cubiculosValidados));
}

function formatearTiempoHHMMSS(tiempoCadena) {
    if (!tiempoCadena) return "--:--:--";
    const str = String(tiempoCadena);
    if (str.length === 6 && !str.includes(":")) {
        return `${str.substring(0, 2)}:${str.substring(2, 4)}:${str.substring(4, 6)}`;
    }
    return str;
}

// --- Sistema de Alertas por Voz y Audio ---
let vocesDisponibles = [];
function cargarVoces() {
    if (window.speechSynthesis) vocesDisponibles = window.speechSynthesis.getVoices();
}
if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = cargarVoces;
    cargarVoces();
}

document.addEventListener("click", () => {
    if (!audioDesbloqueado && window.speechSynthesis) {
        audioDesbloqueado = true;
        let unlockSpeech = new SpeechSynthesisUtterance('');
        window.speechSynthesis.speak(unlockSpeech);
    }
}, { once: true });

const audioTimbre = document.getElementById('timbre');

function encolarConPrioridad(nuevoTipo, nuevoTexto) {
    registrarEnHistorial(nuevoTipo, nuevoTexto);
    if (colaAlertas.some(item => item.texto === nuevoTexto)) return;

    const prioridad = (nuevoTipo === 'OBSTRUCCION') ? 1 : 2;
    const nuevaAlerta = { 
        tipo: nuevoTipo, 
        texto: nuevoTexto, 
        prioridad: prioridad, 
        tiempo: Date.now(),
        repeticionesRestantes: 2
    };

    let insertado = false;
    for (let i = 0; i < colaAlertas.length; i++) {
        if (nuevaAlerta.prioridad < colaAlertas[i].prioridad) {
            colaAlertas.splice(i, 0, nuevaAlerta);
            insertado = true;
            break;
        }
    }
    if (!insertado) colaAlertas.push(nuevaAlerta);
    procesarColaPrioritaria();
}

function procesarColaPrioritaria() {
    if (reproduciendo || colaAlertas.length === 0 || !audioDesbloqueado) return;
    reproduciendo = true;
    const alertaActual = colaAlertas[0];
    if (alertaActual) ejecutarSecuenciaAudio(alertaActual.texto);
}

function ejecutarSecuenciaAudio(texto) {
    const alertaActual = colaAlertas[0];
    if (audioTimbre && audioTimbre.src && alertaActual && alertaActual.tipo === 'OBSTRUCCION') {
        audioTimbre.currentTime = 0;
        audioTimbre.play().then(() => {
            if (audioTimbre) audioTimbre.onended = () => lanzarVozConPausa(texto);
        }).catch(() => lanzarVozConPausa(texto));
    } else {
        lanzarVozConPausa(texto);
    }
}

function lanzarVozConPausa(texto) {
    if (!window.speechSynthesis) {
        reproduciendo = false;
        return;
    }
    const speech = new SpeechSynthesisUtterance(texto);
    speech.lang = 'es-ES';
    let vozEspanol = vocesDisponibles.find(v => v.lang && v.lang.includes('es'));
    if (vozEspanol) speech.voice = vozEspanol;

    speech.onend = () => {
        if (colaAlertas.length === 0) { reproduciendo = false; return; }
        let alertaActual = colaAlertas[0];
        if (alertaActual) {
            alertaActual.repeticionesRestantes--;
            if (alertaActual.repeticionesRestantes > 0) {
                setTimeout(() => ejecutarSecuenciaAudio(texto), 1200);
            } else {
                colaAlertas.shift();
                reproduciendo = false;
                procesarColaPrioritaria();
            }
        }
    };
    speech.onerror = () => {
        reproduciendo = false;
        colaAlertas.shift();
        procesarColaPrioritaria();
    };
    window.speechSynthesis.speak(speech);
}

window.silenciarVoces = function() {
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
        if (audioTimbre) audioTimbre.pause();
    }
    colaAlertas = [];
    reproduciendo = false;
};

window.devolverAlPanelSuperior = function(id) {
    delete cubiculosValidados[id];
    guardarEstadoCubiculos();
    database.ref('bombas').once('value', (snap) => procesarDatosFirebase(snap.val() || {}));
};

window.liberarCubiculo = function(id) {
    delete cubiculosValidados[id];
    delete cubiculosAsignados[id];
    delete estadosAnteriores[id];
    guardarEstadoCubiculos();
    database.ref('bombas').once('value', (snap) => procesarDatosFirebase(snap.val() || {}));
};

window.cambiarCubiculoDirecto = function(id, nuevoCubiculo) {
    cubiculosAsignados[id] = nuevoCubiculo;
    guardarEstadoCubiculos();
    database.ref('bombas').once('value', (snap) => procesarDatosFirebase(snap.val() || {}));
};

function registrarEnHistorial(tipo, mensaje) {
    const hora = new Date().toLocaleTimeString();
    historialEventos.unshift(`[${hora}] [${tipo}] ${mensaje}`);
}

window.mostrarHistorial = function() {
    if (historialEventos.length === 0) {
        alert("Aún no hay registros de eventos en esta sesión.");
    } else {
        alert("📋 REGISTRO DE EVENTOS:\n\n" + historialEventos.join("\n"));
    }
};

function actualizarReloj() {
    const relojEl = document.getElementById('reloj-central');
    if (relojEl) relojEl.innerText = new Date().toLocaleTimeString();
}
setInterval(actualizarReloj, 1000);
actualizarReloj();

window.filtrarTabla = function(estado) {
    filtroEstadoActual = estado;
    database.ref('bombas').once('value', (snap) => procesarDatosFirebase(snap.val() || {}));
};

// =====================================================================
// RECEPCIÓN Y RENDERIZADO OPTIMIZADO
// =====================================================================
database.ref('bombas').on('value', (snapshot) => {
    procesarDatosFirebase(snapshot.val() || {});
});

function procesarDatosFirebase(dataReal) {
    const ahora = Date.now();
    let bombasRealesVivas = {};

    for (let id in dataReal) {
        let b = dataReal[id];
        if (b) {
            if (!b.ts || Math.abs(ahora - b.ts) < 15000) {
                bombasRealesVivas[id] = b;
            }
        }
    }

    actualizarPanelConfiguracion(bombasRealesVivas);
    actualizarTablaMonitoreo(bombasRealesVivas);
}

// 1. Panel Superior (no se recrea si el usuario tiene abierto el select)
function actualizarPanelConfiguracion(data) {
    const contenedorConfig = document.getElementById('lista-configuracion');
    if (!contenedorConfig) return;

    // Si el usuario tiene el foco puesto en un select del panel superior, no redibujamos
    if (document.activeElement && contenedorConfig.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') {
        return;
    }

    let idsConectadas = Object.keys(data);
    let pendientes = idsConectadas.filter(id => !cubiculosValidados[id]);

    if (pendientes.length === 0) {
        contenedorConfig.innerHTML = `<p class="text-muted small mb-0">Esperando conexión de nuevos dispositivos ESP32 o todas las bombas ya tienen cubículo asignado.</p>`;
        return;
    }

    let cubiculosOcupados = Object.entries(cubiculosAsignados)
        .filter(([id, _]) => cubiculosValidados[id])
        .map(([_, cub]) => cub);

    pendientes.forEach(id => {
        if (!cubiculosAsignados[id] || cubiculosOcupados.includes(cubiculosAsignados[id])) {
            for (let i = 1; i <= 12; i++) {
                let numStr = i.toString();
                if (!cubiculosOcupados.includes(numStr)) {
                    cubiculosAsignados[id] = numStr;
                    cubiculosOcupados.push(numStr);
                    break;
                }
            }
        }
    });

    let html = '';
    pendientes.forEach(id => {
        let ocupadosPorOtros = Object.entries(cubiculosAsignados)
            .filter(([bId, _]) => bId !== id && cubiculosValidados[bId])
            .map(([_, cub]) => cub);

        let optionsHTML = '';
        for (let i = 1; i <= 12; i++) {
            let numStr = i.toString();
            let ocupado = ocupadosPorOtros.includes(numStr);
            let seleccionado = cubiculosAsignados[id] === numStr ? 'selected' : '';
            optionsHTML += `<option value="${numStr}" ${seleccionado} ${ocupado ? 'disabled' : ''}>Cubículo ${numStr} ${ocupado ? '(Ocupado)' : ''}</option>`;
        }

        html += `
            <div class="d-flex align-items-center gap-3 mb-2 p-2 bg-white rounded border">
                <strong>Dispositivo: <span class="text-primary">${id}</span></strong>
                <label class="mb-0">Cubículo:</label>
                <select onchange="window.cambiarCubiculoTemp('${id}', this.value)" class="form-select form-select-sm" style="width: auto;">
                    ${optionsHTML}
                </select>
                <button onclick="window.validarBomba('${id}')" class="btn btn-sm btn-primary">
                    Asignar Cubículo
                </button>
            </div>
        `;
    });

    contenedorConfig.innerHTML = html;
}

window.cambiarCubiculoTemp = function(id, val) {
    cubiculosAsignados[id] = val;
    guardarEstadoCubiculos();
};

window.validarBomba = function(id) {
    if (!cubiculosAsignados[id]) cubiculosAsignados[id] = "1";
    cubiculosValidados[id] = true;
    guardarEstadoCubiculos();
    database.ref('bombas').once('value', (snap) => procesarDatosFirebase(snap.val() || {}));
};

// 2. Tabla de Monitoreo (Actualización selectiva sin romper menús activos)
function actualizarTablaMonitoreo(data) {
    const tbody = document.getElementById('cuerpo-tabla');
    if (!tbody) return;

    let validadas = Object.keys(data).filter(id => cubiculosValidados[id]);

    let totalConectadas = Object.keys(data).length;
    let totalActivas = validadas.filter(id => data[id].enEjecucion === 1).length;
    let totalAlertas = 0;

    // Si el usuario está desplegando un select en la tabla, posponemos el redibujado de estructura
    const selectActivo = document.activeElement && tbody.contains(document.activeElement) && document.activeElement.tagName === 'SELECT';

    if (!selectActivo) {
        tbody.innerHTML = '';
        if (validadas.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="text-center py-4 text-muted">No hay bombas asignadas a cubículos. Asigne una bomba arriba para comenzar el monitoreo.</td></tr>`;
        }
    }

    validadas.forEach(id => {
        let bomba = data[id];
        let cubiculoActual = cubiculosAsignados[id] || "1";

        let estadoStr = "LISTO";
        let claseFila = "fila-normal";
        let estadoAnterior = estadosAnteriores[id] || { obstruccion: 0, acabado: 0 };
        let botonAccionHTML = `
            <div class="d-flex gap-1 justify-content-center">
                <button onclick="window.devolverAlPanelSuperior('${id}')" class="btn btn-sm btn-outline-secondary" title="Reasignar cubículo">🔄 Reasignar</button>
            </div>
        `;

        if (bomba.obstruccion === 1) {
            estadoStr = "OBSTRUCCIÓN";
            claseFila = "fila-obstruccion";
            totalAlertas++;
            botonAccionHTML = `
                <div class="d-flex gap-1 justify-content-center">
                    <button onclick="window.silenciarVoces()" class="btn btn-sm btn-danger">Silenciar</button>
                    <button onclick="window.devolverAlPanelSuperior('${id}')" class="btn btn-sm btn-outline-secondary">🔄</button>
                </div>
            `;
            if (estadoAnterior.obstruccion !== 1) {
                encolarConPrioridad('OBSTRUCCION', `Alerta: Bomba en cubículo ${cubiculoActual} con obstrucción`);
            }
        } else if (bomba.acabado === 1) {
            estadoStr = "TERMINADO";
            claseFila = "fila-terminado";
            botonAccionHTML = `
                <div class="d-flex gap-1 justify-content-center">
                    <button onclick="window.liberarCubiculo('${id}')" class="btn btn-sm btn-success">🔓 Liberar</button>
                </div>
            `;
            if (estadoAnterior.acabado !== 1) {
                encolarConPrioridad('TERMINADO', `Bomba en cubículo ${cubiculoActual} ha completado la infusión`);
            }
        } else if (bomba.enEjecucion === 1) {
            estadoStr = "INFUNDIENDO";
            claseFila = "fila-normal";
            botonAccionHTML = `
                <div class="d-flex gap-1 justify-content-center">
                    <span class="badge bg-success d-flex align-items-center">Infundiendo</span>
                    <button onclick="window.devolverAlPanelSuperior('${id}')" class="btn btn-sm btn-outline-secondary" title="Cambiar de cubículo">🔄</button>
                </div>
            `;
        }

        estadosAnteriores[id] = { obstruccion: bomba.obstruccion, acabado: bomba.acabado };

        if (filtroEstadoActual !== 'TODOS' && estadoStr !== filtroEstadoActual) return;

        if (!selectActivo) {
            let ocupadosPorOtrasValidadas = Object.entries(cubiculosAsignados)
                .filter(([bId, _]) => bId !== id && cubiculosValidados[bId])
                .map(([_, cub]) => cub);

            let selectorCubiculoHTML = `<select class="form-select form-select-sm fw-bold" style="width: auto; min-width: 110px;" onchange="window.cambiarCubiculoDirecto('${id}', this.value)">`;
            for (let c = 1; c <= 12; c++) {
                let cStr = c.toString();
                let ocupado = ocupadosPorOtrasValidadas.includes(cStr);
                let selected = (cubiculoActual === cStr) ? 'selected' : '';
                selectorCubiculoHTML += `<option value="${cStr}" ${selected} ${ocupado ? 'disabled' : ''}>Cubículo ${cStr} ${ocupado ? '(Ocupado)' : ''}</option>`;
            }
            selectorCubiculoHTML += `</select>`;

            let fila = document.createElement('tr');
            fila.id = `fila-${id}`;
            fila.className = claseFila;
            fila.innerHTML = `
                <td><strong>${id}</strong></td>
                <td>${selectorCubiculoHTML}</td>
                <td>${bomba.fecha || "-"}</td>
                <td>${bomba.horaInicio || "-"}</td>
                <td>${bomba.volumen || 100} ml</td>
                <td>${bomba.gotas || 0} ${bomba.esHora ? "g/h" : "g/m"}</td>
                <td class="font-monospace fw-bold">${formatearTiempoHHMMSS(bomba.tiempoRestante)}</td>
                <td><strong>${estadoStr}</strong></td>
                <td class="text-center">${botonAccionHTML}</td>
            `;
            tbody.appendChild(fila);
        }
    });

    const kpiTotal = document.getElementById('kpi-total');
    const kpiProceso = document.getElementById('kpi-proceso');
    const kpiAlertas = document.getElementById('kpi-alertas');

    if (kpiTotal) kpiTotal.innerText = totalConectadas;
    if (kpiProceso) kpiProceso.innerText = `${totalActivas} / ${totalConectadas}`;
    if (kpiAlertas) kpiAlertas.innerText = totalAlertas > 0 ? `${totalAlertas} Alerta${totalAlertas > 1 ? 's' : ''}` : 'Sin alertas';
}