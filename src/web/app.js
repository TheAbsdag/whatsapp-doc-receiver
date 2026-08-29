'use strict';

const $ = (sel) => document.querySelector(sel);

const PAGE = 25; // elementos por página (la vista principal se mantiene esquelética)

let avisoTimer = null;
let toastTimer = null;
let ordenAsc = false; // por defecto: más recientes primero
let pagina = 0;
let docsTotal = 0;
let documentosActuales = [];

// Cola de impresión: los clics NUNCA se descartan; se imprimen de a un
// documento (descarga automática si hace falta) para no "saltarse" ninguno.
let cola = [];
let procesandoId = null;

// Detección de novedades para la notificación no intrusiva.
let primeraCarga = true;
let ultimoIdNuevo = null;
let ultimoEstadoClave = null;

let refrescando = false;

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

function fmtHora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
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

/** Aviso no intrusivo en la esquina (toast). */
function toast(texto) {
  const el = $('#toast');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/** Notificación del sistema + toast discreto. NUNCA envía mensajes de WhatsApp. */
function notificar(titulo, cuerpo) {
  toast(`${titulo}: ${cuerpo}`);
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(titulo, { body: cuerpo });
    } catch { /* el navegador puede bloquearla; el toast ya avisó */ }
  }
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
  tr.dataset.id = doc.id;
  tr.dataset.jid = doc.remoteJid || '';
  tr.title = 'Toca la fila para ver el contexto del chat';

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

  // Acciones: vista previa · descargar · imprimir (imprimir descarga automáticamente)
  const tdAcciones = document.createElement('td');
  for (const [action, titulo] of [['preview', 'Vista previa'], ['download', 'Descargar'], ['print', 'Imprimir']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = titulo;
    btn.dataset.id = doc.id;
    btn.dataset.action = action;
    if (procesandoId === doc.id) btn.disabled = true;
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

  for (const doc of documentosActuales) tbody.appendChild(crearFila(doc));
}

function renderPagina() {
  const totalPaginas = Math.max(1, Math.ceil(docsTotal / PAGE));
  if (pagina >= totalPaginas) pagina = totalPaginas - 1;
  $('#pagina-info').textContent = `Página ${pagina + 1} de ${totalPaginas} · ${docsTotal} documento${docsTotal === 1 ? '' : 's'}`;
  $('#btn-prev').disabled = pagina === 0;
  $('#btn-next').disabled = pagina >= totalPaginas - 1;
}

/** Compara el estado anterior y avisa (solo) lo que cambió. */
function detectarNovedades(st, docNuevo) {
  const estadoClave = st.requiresQr ? 'qr' : st.connected ? 'ok' : 'recon';

  if (!primeraCarga) {
    if (ultimoEstadoClave === 'ok' && estadoClave !== 'ok') {
      notificar('Receptor de documentos', 'La conexión con WhatsApp se perdió; se está reconectando…');
    } else if (ultimoEstadoClave === 'recon' && estadoClave === 'ok') {
      notificar('Receptor de documentos', 'Conexión con WhatsApp restablecida.');
    }
    if (docNuevo && docNuevo.id !== ultimoIdNuevo) {
      notificar('Nuevo documento', `De ${docNuevo.from || '—'}: ${docNuevo.filename || '(sin nombre)'}`);
    }
  }

  ultimoEstadoClave = estadoClave;
  if (docNuevo) ultimoIdNuevo = docNuevo.id;
  primeraCarga = false;
}

async function refresh() {
  if (refrescando) return;
  refrescando = true;
  try {
    const [st, data, nuevos] = await Promise.all([
      api('/api/status'),
      api(`/api/documents?limit=${PAGE}&offset=${pagina * PAGE}${ordenAsc ? '&order=asc' : ''}`),
      api('/api/documents?limit=1&offset=0'), // el más reciente, siempre (para avisar)
    ]);
    renderEstado(st);
    docsTotal = data.total ?? 0;
    renderTabla(data.documents || []);
    renderPagina();
    detectarNovedades(st, nuevos.documents?.[0]);
  } catch (e) {
    setMensaje('Error al actualizar: ' + e.message, true);
  } finally {
    refrescando = false;
  }
}

// ---------------------------------------------------------------------------
// Cola de impresión (un documento a la vez; descarga automática si hace falta)
// ---------------------------------------------------------------------------

function encolar(doc) {
  if (!doc || cola.includes(doc.id) || procesandoId === doc.id) return;
  cola.push(doc.id);
  pintarColaEstado();
  procesarCola();
}

function pintarColaEstado() {
  const enCurso = procesandoId
    ? (documentosActuales.find((d) => d.id === procesandoId)?.filename || procesandoId)
    : null;
  const texto = enCurso
    ? `Imprimiendo: ${enCurso}${cola.length ? ` · en cola: ${cola.length}` : ''}`
    : cola.length ? `En cola: ${cola.length}` : '';
  setMensaje(texto);
}

async function procesarCola() {
  if (procesandoId !== null) return;
  while (cola.length) {
    const id = cola.shift();
    const doc = documentosActuales.find((d) => d.id === id);
    if (!doc) continue;
    procesandoId = id;
    renderTabla(documentosActuales); // deshabilita la fila en curso
    pintarColaEstado();
    try {
      if (doc.status !== 'downloaded') {
        setMensaje(`Descargando ${doc.filename}…`);
        await api(`/api/documents/${encodeURIComponent(id)}/download`, { method: 'POST' });
      }
      setMensaje(`Imprimiendo ${doc.filename}…`);
      const r = await api(`/api/documents/${encodeURIComponent(id)}/print`, { method: 'POST' });
      setMensaje(r.message || 'Solicitud de impresión enviada.');
    } catch (e) {
      setMensaje(e.message, true);
    } finally {
      procesandoId = null;
    }
  }
  renderTabla(documentosActuales);
  pintarColaEstado();
  await refresh();
}

// ---------------------------------------------------------------------------
// Contexto del chat (últimos mensajes, solo lectura)
// ---------------------------------------------------------------------------

async function abrirContexto(jid, docId) {
  if (!jid) return;
  const panel = $('#contexto-panel');
  const zona = $('#contexto-msgs');
  try {
    const r = await api(`/api/chat/${encodeURIComponent(jid)}/messages?limit=20`);
    $('#contexto-titulo').textContent = `Contexto del chat · ${jid}`;
    zona.textContent = '';
    const msgs = r.messages || [];
    if (!msgs.length) {
      zona.className = 'vacio';
      zona.textContent = 'Sin mensajes registrados todavía (el contexto se guarda desde ahora).';
    } else {
      zona.className = '';
      for (const m of msgs) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + (m.fromMe ? 'mio ' : '') + (m.id === docId ? 'destacado' : '');
        const cuerpo = m.kind === 'texto' ? m.text
          : m.kind === 'documento' ? `📄 ${m.filename || 'documento'}${m.text ? ` — ${m.text}` : ''}`
          : m.kind === 'imagen' ? `🖼️ ${m.text || 'imagen'}${m.filename ? ` (${m.filename})` : ''}`
          : m.kind;
        div.textContent = `${fmtHora(m.ts)} · ${m.fromMe ? 'Yo' : m.remoteJid}\n${cuerpo}`;
        zona.appendChild(div);
      }
    }
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    setMensaje('No se pudo cargar el contexto: ' + e.message, true);
  }
}

// ---------------------------------------------------------------------------
// Vista previa del documento (PDF/imagen en el navegador)
// ---------------------------------------------------------------------------

async function abrirPreview(doc) {
  const panel = $('#preview-panel');
  const zona = $('#preview-contenido');
  $('#preview-titulo').textContent = doc.filename || 'Vista previa';
  $('#preview-imprimir').dataset.id = doc.id;
  zona.textContent = '';
  panel.hidden = false;

  if (doc.status !== 'downloaded') {
    zona.textContent = 'Descargando…';
    try {
      await api(`/api/documents/${encodeURIComponent(doc.id)}/download`, { method: 'POST' });
      await refresh();
    } catch (e) {
      zona.textContent = 'No se pudo descargar: ' + e.message;
      return;
    }
  }

  const ext = (doc.filename || '').split('.').pop().toLowerCase();
  const url = `/api/documents/${encodeURIComponent(doc.id)}/file`;
  if (ext === 'pdf') {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.title = 'Vista previa';
    zona.appendChild(iframe);
  } else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Vista previa';
    zona.appendChild(img);
  } else {
    const p = document.createElement('p');
    p.className = 'aviso';
    p.textContent = `Vista previa no disponible para archivos .${ext} (solo PDF e imágenes).`;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Abrir en una pestaña nueva';
    p.appendChild(document.createElement('br'));
    p.appendChild(a);
    zona.appendChild(p);
  }
}

// ---------------------------------------------------------------------------
// Arranque e interacción
// ---------------------------------------------------------------------------

async function principal() {
  let printerGuardada = '';
  try {
    const r = await api('/api/printer');
    printerGuardada = r.printer || '';
  } catch { /* el servidor puede no estar listo aún */ }
  await cargarImpresoras(printerGuardada);

  if ('Notification' in window && Notification.permission === 'default') {
    const btn = $('#btn-notif');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      try {
        const p = await Notification.requestPermission();
        btn.hidden = p !== 'default';
        if (p === 'granted') setMensaje('Notificaciones activadas. Avisaremos sin molestar.');
      } catch { btn.hidden = false; }
    });
  }

  $('#btn-qr').addEventListener('click', cargarQr);

  // Registro de diagnóstico: permite ver qué está fallando sin abrir archivos.
  $('#btn-logs').addEventListener('click', async () => {
    try {
      const r = await api('/api/debug-log');
      $('#logs-titulo').textContent = `Registro: ${r.file}`;
      $('#logs-contenido').textContent = (r.lines || []).join('\n') || '(sin líneas)';
      $('#logs-panel').hidden = false;
    } catch (e) {
      setMensaje('No se pudo leer el log: ' + e.message, true);
    }
  });
  $('#logs-cerrar').addEventListener('click', () => { $('#logs-panel').hidden = true; });

  $('#btn-actualizar').addEventListener('click', () => {
    refresh();
    cargarImpresoras();
  });

  $('#btn-orden').addEventListener('click', () => {
    ordenAsc = !ordenAsc;
    pagina = 0;
    $('#btn-orden').textContent = ordenAsc ? 'Nuevos primero' : 'Antiguos primero';
    refresh();
  });

  $('#btn-prev').addEventListener('click', () => {
    if (pagina > 0) { pagina--; refresh(); }
  });
  $('#btn-next').addEventListener('click', () => {
    pagina++;
    refresh();
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

  $('#contexto-cerrar').addEventListener('click', () => { $('#contexto-panel').hidden = true; });
  $('#preview-cerrar').addEventListener('click', () => { $('#preview-panel').hidden = true; });
  $('#preview-imprimir').addEventListener('click', () => {
    const id = $('#preview-imprimir').dataset.id;
    const doc = documentosActuales.find((d) => d.id === id);
    $('#preview-panel').hidden = true;
    encolar(doc);
  });

  $('#filas').addEventListener('click', async (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    const btn = ev.target.closest('button[data-action]');
    if (btn && !btn.disabled) {
      const doc = documentosActuales.find((d) => d.id === btn.dataset.id);
      if (!doc) return;
      if (btn.dataset.action === 'print') {
        encolar(doc);
      } else if (btn.dataset.action === 'download') {
        btn.disabled = true;
        try {
          const r = await api(`/api/documents/${encodeURIComponent(doc.id)}/download`, { method: 'POST' });
          setMensaje(`Descargado: ${r.fileName}`);
          await refresh();
        } catch (e) {
          setMensaje(e.message, true);
          btn.disabled = false;
        }
      } else if (btn.dataset.action === 'preview') {
        await abrirPreview(doc);
      }
      return;
    }
    if (tr && !btn) abrirContexto(tr.dataset.jid, tr.dataset.id);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh(); // al volver a la pestaña, actualiza sin esperar el poll
  });

  await refresh();
  setInterval(refresh, 5000); // refresco automático cada 5 s
}

principal();
