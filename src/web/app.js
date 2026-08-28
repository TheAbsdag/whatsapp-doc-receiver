'use strict';

const $ = (sel) => document.querySelector(sel);

let avisoTimer = null;
let accionEnCurso = false;
let ordenAsc = false; // por defecto: más recientes primero
let documentosActuales = [];

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }
  return data;
}

function fmtBytes(n) {
  if (typeof n !== 'number' && !n) return '—';
  if (n < 1024) return `${n} B`;
  const unidades = ['KB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < unidades.length - 1);
  return `${v.toFixed(1)} ${unidades[i]}`;
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function setMensaje(texto, esError = false) {
  const el = $('#mensaje');
  el.textContent = texto;
  el.className = 'mensaje ' + (esError ? 'error' : 'ok');
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => {
    el.textContent = '';
    el.className = 'mensaje';
  }, 8000);
}

function renderEstado(st) {
  const el = $('#estado');
  if (st.requiresQr) {
    el.textContent = 'Desconectado (requiere QR)';
    el.className = 'estado bad';
  } else if (st.connected) {
    el.textContent = 'Conectado';
    el.className = 'estado ok';
  } else {
    el.textContent = 'Reconectando…';
    el.className = 'estado warn';
  }
  $('#ultimo-mensaje').textContent = st.lastMessageAt
    ? `Último mensaje: ${fmtFecha(st.lastMessageAt)}`
    : '';
  $('#qr-panel').hidden = !st.requiresQr;
  if (st.requiresQr) cargarQr();
}

async function cargarQr() {
  try {
    const { qrBase64 } = await api('/api/qr');
    $('#qr-img').src = 'data:image/png;base64,' + qrBase64;
    $('#qr-img').hidden = false;
    $('#qr-msg').textContent = '';
  } catch {
    $('#qr-img').hidden = true;
    $('#qr-msg').textContent = 'Aún no hay QR disponible; la conexión se está preparando (revisa los logs del servicio si persiste).';
  }
}

/** Carga el dropdown con las impresoras del sistema (lpstat -a). */
async function cargarImpresoras(seleccion) {
  const sel = $('#impresora');
  const actual = seleccion !== undefined ? seleccion : sel.value;
  let lista = [];
  let error = '';
  try {
    const r = await api('/api/printers');
    lista = r.printers || [];
    error = r.error || '';
  } catch (e) {
    error = e.message;
  }
  sel.textContent = '';
  sel.appendChild(new Option('(Por defecto — impresora del sistema)', ''));
  for (const nombre of lista) sel.appendChild(new Option(nombre, nombre));
  if (actual && ![...sel.options].some((o) => o.value === actual)) {
    sel.appendChild(new Option(`${actual} (no disponible)`, actual));
  }
  if (actual) sel.value = actual;
  $('#impresoras-aviso').textContent = error
    ? `No se pudo detectar impresoras: ${error}`
    : '';
}

function crearFila(doc) {
  const tr = document.createElement('tr');

  // Fecha y hora
  const tdFecha = document.createElement('td');
  tdFecha.textContent = fmtFecha(doc.receivedAt);
  tr.appendChild(tdFecha);

  // Origen (enviado / recibido)
  const tdOrigen = document.createElement('td');
  const spanOrigen = document.createElement('span');
  const enviado = doc.direction === 'sent';
  spanOrigen.className = 'origen ' + (enviado ? 'enviado' : 'recibido');
  spanOrigen.textContent = enviado ? 'Enviado' : 'Recibido';
  tdOrigen.appendChild(spanOrigen);
  tr.appendChild(tdOrigen);

  // Remitente
  const tdRemitente = document.createElement('td');
  tdRemitente.textContent = enviado ? 'Yo' : (doc.from || doc.remoteJid || '—');
  tr.appendChild(tdRemitente);

  // Nombre y tamaño
  for (const texto of [doc.filename || '—', fmtBytes(doc.size)]) {
    const td = document.createElement('td');
    td.textContent = texto; // textContent: nunca se interpreta HTML
    tr.appendChild(td);
  }

  // Estado
  const tdEstado = document.createElement('td');
  const spanEstado = document.createElement('span');
  spanEstado.className = 'estado ' + (doc.status === 'downloaded' ? 'ok' : 'warn');
  spanEstado.textContent = doc.status === 'downloaded' ? 'Descargado' : 'Pendiente';
  tdEstado.appendChild(spanEstado);
  tr.appendChild(tdEstado);

  // Acciones
  const tdAcciones = document.createElement('td');
  for (const [action, titulo] of [['download', 'Descargar'], ['print', 'Imprimir']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = titulo;
    btn.dataset.id = doc.id;
    btn.dataset.action = action;
    if (action === 'print' && doc.status !== 'downloaded') btn.disabled = true;
    tdAcciones.appendChild(btn);
  }
  tr.appendChild(tdAcciones);
  return tr;
}

function renderTabla(documentos) {
  documentosActuales = Array.isArray(documentos) ? documentos : [];
  const tbody = $('#filas');
  tbody.textContent = '';

  if (!documentosActuales.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'vacio';
    td.textContent = 'No hay documentos recibidos todavía.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const lista = [...documentosActuales].sort((a, b) => {
    const cmp = String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''));
    return ordenAsc ? cmp : -cmp;
  });
  for (const doc of lista) tbody.appendChild(crearFila(doc));
}

async function refresh() {
  if (accionEnCurso) return; // no re-renderizar mientras el usuario está tocando una acción
  try {
    const [st, data] = await Promise.all([api('/api/status'), api('/api/documents')]);
    renderEstado(st);
    renderTabla(data.documents || []);
  } catch (e) {
    setMensaje('Error al actualizar: ' + e.message, true);
  }
}

async function principal() {
  let printerGuardada = '';
  try {
    const r = await api('/api/printer');
    printerGuardada = r.printer || '';
  } catch { /* el servidor puede no estar listo aún */ }
  await cargarImpresoras(printerGuardada);

  $('#btn-qr').addEventListener('click', cargarQr);
  $('#btn-actualizar').addEventListener('click', () => {
    refresh();
    cargarImpresoras();
  });

  $('#btn-orden').addEventListener('click', () => {
    ordenAsc = !ordenAsc;
    $('#btn-orden').textContent = ordenAsc ? 'Nuevos primero' : 'Antiguos primero';
    renderTabla(documentosActuales);
  });

  $('#btn-impresora').addEventListener('click', async () => {
    try {
      await api('/api/printer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printer: $('#impresora').value.trim() }),
      });
      setMensaje('Impresora configurada.');
    } catch (e) {
      setMensaje('No se pudo guardar: ' + e.message, true);
    }
  });

  $('#filas').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-action]');
    if (!btn || btn.disabled || accionEnCurso) return;
    accionEnCurso = true;
    btn.disabled = true;
    const id = encodeURIComponent(btn.dataset.id);
    try {
      if (btn.dataset.action === 'download') {
        const r = await api(`/api/documents/${id}/download`, { method: 'POST' });
        setMensaje(`Descargado: ${r.fileName}`);
      } else {
        const r = await api(`/api/documents/${id}/print`, { method: 'POST' });
        setMensaje(r.message || 'Solicitud de impresión enviada.');
      }
    } catch (e) {
      setMensaje(e.message, true);
    } finally {
      accionEnCurso = false;
    }
    refresh();
  });

  await refresh();
  setInterval(refresh, 5000); // refresco automático cada 5 s
}

principal();
