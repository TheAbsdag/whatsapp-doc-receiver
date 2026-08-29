// Test de simulación (sin WhatsApp real): inyecta documentos de prueba en el
// store y verifica todo el flujo HTTP: lista → descarga (saneado + sin
// colisiones) → impresión vía lp (impresora simulada) → casos de error.
//
// Requisitos del entorno de desarrollo: no hay WhatsApp, no hay CUPS y no hay
// systemd, así que este archivo demuestra la lógica completa excepto la
// conexión real de Baileys (que solo se puede probar con un teléfono real).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(AQUI, '.tmp')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR = path.join(TMP, 'data')
process.env.WHATSAPP_DOC_RECEIVER_TMP_DIR = TMP
process.env.WHATSAPP_DOC_RECEIVER_DEBUG_LOG = path.join(TMP, 'receptor-debug.log')
process.env.FAKE_LP_LOG = path.join(TMP, 'lp.log')

const { sanitizeFilename, saveDownload } = await import('../src/files.js')
const store = await import('../src/store.js')
const { createApp } = await import('../src/index.js')

const DIROUT = path.join(TMP, 'descargas')
const DIROUT2 = path.join(TMP, 'descargas-colis') // aislado para la prueba de colisiones
const FAKE_LP = path.join(AQUI, 'fake-lp.js')

let fallos = 0
function ok(cond, msg) {
  if (cond) {
    console.log('  ✔ ' + msg)
  } else {
    fallos++
    console.error('  ✘ ' + msg)
  }
}

// PDF mínimo (el contenido no se valida: solo se guarda y se imprime la ruta)
const PDF = Buffer.from('%PDF-1.4\n% WDR-test\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>> endobj\n%%EOF\n')

function registro(id, filename, size = 12345, ts = new Date().toISOString(), fromMe = false) {
  return {
    id,
    remoteJid: '5491155555555@s.whatsapp.net',
    from: 'Probador',
    filename,
    mime: 'application/pdf',
    size,
    caption: 'documento de prueba',
    receivedAt: ts,
    direction: fromMe ? 'sent' : 'received',
    status: 'pending',
    path: null,
    message: {
      key: { id, remoteJid: '5491155555555@s.whatsapp.net', fromMe },
      pushName: fromMe ? '' : 'Probador',
      messageTimestamp: Math.floor(new Date(ts).getTime() / 1000),
      message: { documentMessage: { fileName: filename, mimetype: 'application/pdf', fileLength: size } },
    },
  }
}

// ---------------------------------------------------------------------------
// 1) Saneado de nombres
// ---------------------------------------------------------------------------
console.log('\n[1] Saneado de nombres de archivo')
{
  const s1 = sanitizeFilename('../../etc/passwd')
  ok(!s1.includes('/') && !s1.includes('\\') && !s1.startsWith('.') && s1.length > 0, `'../../etc/passwd' → '${s1}' (sin separadores, sin puntos iniciales)`)
  ok(sanitizeFilename('informe:final/2024..pdf') === 'informe_final_2024..pdf', `'informe:final/2024..pdf' → '${sanitizeFilename('informe:final/2024..pdf')}'`)
  ok(sanitizeFilename('\\server\\share\\x.pdf') === '_server_share_x.pdf', `ruta de Windows → '${sanitizeFilename('\\server\\share\\x.pdf')}'`)
  ok(sanitizeFilename('') === 'documento', "cadena vacía → 'documento'")
  ok(sanitizeFilename('   ').length > 0, 'solo espacios → nombre por defecto')
  ok(sanitizeFilename('a\u0000b\u001fc.pdf') === 'a_b_c.pdf', 'caracteres de control reemplazados')
}

// ---------------------------------------------------------------------------
// 2) Colisiones de nombres
// ---------------------------------------------------------------------------
console.log('\n[2] Colisiones (sufijo " (1)", " (2)"…)')
{
  const p1 = saveDownload(PDF, DIROUT2, 'Informe.pdf')
  const p2 = saveDownload(PDF, DIROUT2, 'Informe.pdf')
  ok(fs.existsSync(p1) && fs.existsSync(p2), 'ambos archivos existen')
  ok(path.basename(p1) === 'Informe.pdf' && path.basename(p2) === 'Informe (1).pdf', `'${path.basename(p1)}' + '${path.basename(p2)}'`)
  const p3 = saveDownload(PDF, DIROUT2, 'Informe.pdf')
  ok(path.basename(p3) === 'Informe (2).pdf', `tercero → '${path.basename(p3)}'`)
}

// ---------------------------------------------------------------------------
// 3) Servidor con API simulada (sin Baileys)
// ---------------------------------------------------------------------------
console.log('\n[3] Arranque del servidor HTTP (API simulada)')
store.load()
const apiFake = {
  getStatus: () => ({ connected: false, loggedIn: false, requiresQr: true }),
  getQrString: () => 'WDR-TEST-QR',
  downloadMedia: async () => PDF,
}
const cfg = {
  port: 0,
  host: '127.0.0.1',
  downloadsDir: DIROUT,
  printer: 'impresora-prueba',
  lpBin: process.execPath,
  lpArgsPrefix: [FAKE_LP],
  persistConfig: false,
}
const server = createApp({ config: cfg, api: apiFake }).listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`

async function api(pathReq, opts = {}) {
  const res = await fetch(base + pathReq, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

console.log('\n[4] Página web')
{
  const res = await fetch(base + '/')
  const html = await res.text()
  ok(res.status === 200 && html.includes('Receptor de documentos'), `GET / → ${res.status}, página carga`)
}

console.log('\n[5] Inyección de documentos (recibidos + enviados) y orden cronológico')
store.add(registro('TESTDOC-1', 'Informe.pdf', 12345, '2024-01-01T10:00:00Z'))
store.add(registro('TESTDOC-2', 'Informe.pdf', 12345, '2024-02-01T10:00:00Z'))
store.add(registro('TESTDOC-3', 'informe:final/2024..pdf', 67890, '2024-03-01T10:00:00Z'))
store.add(registro('TESTDOC-4', 'Pendiente.pdf', 100, '2024-04-01T10:00:00Z'))
store.add(registro('TESTDOC-5', 'Enviado-por-mi.pdf', 2222, '2024-05-01T10:00:00Z', true))
{
  const { status, data } = await api('/api/documents')
  ok(status === 200 && data.documents.length === 5, `GET /api/documents → 5 registros`)
  const ids = data.documents.map((d) => d.id)
  ok(
    JSON.stringify(ids) === JSON.stringify(['TESTDOC-5', 'TESTDOC-4', 'TESTDOC-3', 'TESTDOC-2', 'TESTDOC-1']),
    `orden cronológico descendente: ${ids.join(', ')}`,
  )
  ok(data.documents[0].direction === 'sent' && data.documents[1].direction === 'received', 'documentos enviados y recibidos distinguidos (direction)')
  ok(!('message' in data.documents[0]) && data.documents[0].status === 'pending', 'la respuesta pública no filtra el mensaje crudo')
}

console.log('\n[6] Descarga (media simulada)')
{
  const s = await api('/api/documents/TESTDOC-1/download', { method: 'POST' })
  ok(s.status === 200 && s.data.ok === true && s.data.fileName === 'Informe.pdf', `download TESTDOC-1 → ${s.status} '${s.data.fileName}'`)
  ok(fs.existsSync(s.data.path), `archivo existe: ${s.data.path}`)
}
{
  const s = (await api('/api/documents')).data.documents.find((d) => d.id === 'TESTDOC-1')
  ok(s.status === 'downloaded' && s.id === 'TESTDOC-1', 'registro pasa a "downloaded"')
}
{
  const d = (await api('/api/documents/TESTDOC-2/download', { method: 'POST' }))
  ok(d.status === 200 && d.data.fileName === 'Informe (1).pdf', `colisión → '${d.data.fileName}'`)
}
{
  const d = (await api('/api/documents/TESTDOC-3/download', { method: 'POST' }))
  ok(d.status === 200 && d.data.fileName === 'informe_final_2024..pdf', `saneado en descarga → '${d.data.fileName}'`)
}

console.log('\n[7] Impresión (lp simulado)')
{
  const d = (await api('/api/documents/TESTDOC-1/print', { method: 'POST' }))
  ok(d.status === 200 && d.data.ok === true, `print TESTDOC-1 → ${d.status} ok:true`)
  const linea = fs.readFileSync(process.env.FAKE_LP_LOG, 'utf8').trim().split('\n').pop()
  const inv = JSON.parse(linea).args
  ok(inv.includes('-d') && inv.includes('impresora-prueba') && inv.includes('--'), `lp recibió: -d impresora-prueba --`)
  ok(inv[inv.length - 1] === store.get('TESTDOC-1').path, 'ruta pasada como argumento final')
}
{
  process.env.FAKE_LP_FAIL = '1'
  const d = (await api('/api/documents/TESTDOC-2/print', { method: 'POST' }))
  delete process.env.FAKE_LP_FAIL
  ok(d.status === 500 && d.data.ok === false && /impresora no existe/.test(d.data.message), `fallo de lp se reporta: ${JSON.stringify(d.data.message)}`)
}

console.log('\n[8] Códigos de error coherentes')
{
  const d = (await api('/api/documents/NOEXISTE/download', { method: 'POST' }))
  ok(d.status === 404 && /no encontrado/i.test(d.data.error || ''), 'download de id inexistente → 404')
  const p = (await api('/api/documents/NOEXISTE/print', { method: 'POST' }))
  ok(p.status === 404, 'print de id inexistente → 404')
  const p2 = (await api('/api/documents/TESTDOC-4/print', { method: 'POST' }))
  ok(p2.status === 409 && /no está descargado/.test(p2.data.error || ''), 'print sin descargar → 409')
}

console.log('\n[9] Estado, QR, impresoras (dropdown) y configuración')
{
  const s = (await api('/api/status'))
  ok(s.status === 200 && s.data.requiresQr === true && s.data.connected === false, `GET /api/status → ${JSON.stringify(s.data)}`)
  ok('lastMessageAt' in s.data, 'status incluye lastMessageAt')
  ok(typeof s.data.version === 'string' && s.data.version.length > 0, `status incluye versión de la app (${s.data.version})`)
}
{
  const q = (await api('/api/qr'))
  ok(q.status === 200 && /^iVBORw0KGgo/.test(q.data.qrBase64 || ''), 'QR pendiente → PNG base64')
}
{
  process.env.FAKE_LP_PRINTERS = 'hp_laserjet\netiquetas\nhp_laserjet'
  const p = await api('/api/printers')
  delete process.env.FAKE_LP_PRINTERS
  ok(p.status === 200 && JSON.stringify(p.data.printers) === JSON.stringify(['etiquetas', 'hp_laserjet']), `GET /api/printers → ${JSON.stringify(p.data.printers)} (dedupe + orden)`)
}
{
  process.env.FAKE_LP_FAIL = '1'
  const p = await api('/api/printers')
  delete process.env.FAKE_LP_FAIL
  ok(p.status === 200 && Array.isArray(p.data.printers) && p.data.printers.length === 0 && p.data.error, 'lpstat sin CUPS → lista vacía con error reportado')
}
{
  const guardado = await api('/api/printer', { method: 'POST', body: JSON.stringify({ printer: 'hp_laserjet' }) })
  const leido = await api('/api/printer')
  ok(guardado.status === 200 && leido.data.printer === 'hp_laserjet', 'POST/GET /api/printer persiste la selección del dropdown')
}
{
  // Adapter por defecto según plataforma (Windows: Get-Printer · Linux: lpstat):
  // no debe lanzar y debe devolver lista o error coherente.
  const { listPrinters } = await import('../src/printer.js')
  const r = await listPrinters({})
  ok(
    Array.isArray(r.printers) && (r.printers.length > 0 || typeof r.error === 'string'),
    `listPrinters() por defecto (${process.platform}) → ${JSON.stringify(r).slice(0, 80)}`,
  )
}

console.log('\n[10] Persistencia atómica del store')
{
  const datos = JSON.parse(fs.readFileSync(path.join(process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR, 'documents.json'), 'utf8'))
  ok(Array.isArray(datos) && datos.length === 5, 'documents.json contiene los 5 registros')
  const temporales = fs.readdirSync(process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR).filter((f) => f.endsWith('.tmp'))
  ok(temporales.length === 0, 'no quedan archivos .tmp (escritura atómica)')
}
{
  const s = (await api('/api/status'))
  ok(s.data.lastMessageAt === null, 'lastMessageAt inicia en null (sin mensajes reales)')
}

console.log('\n[11] Paginación (25 por página; total y orden)')
{
  let r = await api('/api/documents?limit=2&offset=0')
  ok(r.status === 200 && r.data.documents.length === 2 && r.data.total === 5 && r.data.offset === 0 && r.data.limit === 2,
    `limit=2&offset=0 → 2 docs, total ${r.data.total}, offset ${r.data.offset}`)
  ok(r.data.documents[0].id === 'TESTDOC-5' && r.data.documents[1].id === 'TESTDOC-4', 'primera página: los más recientes')
  r = await api('/api/documents?limit=2&offset=4')
  ok(r.status === 200 && r.data.documents.length === 1 && r.data.documents[0].id === 'TESTDOC-1', 'última página: 1 documento (TESTDOC-1)')
  r = await api('/api/documents?limit=2&offset=0&order=asc')
  ok(r.status === 200 && r.data.documents[0].id === 'TESTDOC-1', 'order=asc → primero el más antiguo')
  r = await api('/api/documents?limit=200&offset=0')
  ok(r.data.documents.length === 5 && r.data.limit === 200, 'limit alto devuelve todo')
}

console.log('\n[12] Contexto del chat (chatlog acotado, cronológico antiguo → reciente)')
{
  const jid = '5491155555555@s.whatsapp.net'
  // 25 mensajes: CT-00 (el más antiguo) … CT-24 (el más reciente)
  for (let i = 0; i < 25; i++) {
    store.chatAdd({
      id: `CT-${String(i).padStart(2, '0')}`,
      remoteJid: jid,
      fromMe: i % 2 === 0,
      ts: new Date(Date.UTC(2024, 5, 1, 10, i)).toISOString(),
      kind: i % 3 === 0 ? 'documento' : 'texto',
      text: `mensaje ${i}`,
      filename: i % 3 === 0 ? `doc-${i}.pdf` : '',
      mime: i % 3 === 0 ? 'application/pdf' : '',
    })
  }
  store.chatAdd({ id: 'TESTDOC-1', remoteJid: jid, ts: new Date().toISOString(), kind: 'documento', text: 'doc de prueba', filename: 'Informe.pdf', mime: 'application/pdf' })

  let r = await api(`/api/chat/${jid}/messages?limit=20`)
  ok(r.status === 200 && r.data.messages.length === 20, `GET /api/chat → ${r.data.messages.length} mensajes (límite 20)`)
  // Con 25 mensajes + el documento, el recorte conserva los 20 más recientes:
  // el más antiguo sobreviviente es CT-06 (CT-05 fue descartado al superar 20).
  ok(r.data.messages[0].id === 'CT-06' && r.data.messages[19].id === 'TESTDOC-1',
    `orden cronológico antiguo → reciente: ${r.data.messages[0].id} … ${r.data.messages[19].id} (recorte a 20)`)
  ok(r.data.messages[0].kind === 'documento' && r.data.messages[1].kind === 'texto', 'kinds preservados (documento/texto)')
  r = await api(`/api/chat/${jid}/messages`)
  ok(r.status === 200 && r.data.messages.length === 20, 'límite por defecto 20 sin parámetro')
  r = await api('/api/chat/NOEXISTE-999/messages')
  ok(r.status === 200 && r.data.messages.length === 0, 'chat sin mensajes → lista vacía (200)')
}

console.log('\n[13] Vista previa: servir el archivo descargado')
{
  let r = await fetch(base + '/api/documents/TESTDOC-1/file')
  ok(r.status === 200, `GET /file (descargado) → ${r.status}`)
  ok((r.headers.get('content-type') || '').includes('application/pdf'), 'content-type application/pdf')
  const cuerpo = await r.text()
  ok(cuerpo.startsWith('%PDF'), 'cuerpo es el PDF descargado')
  r = await fetch(base + '/api/documents/TESTDOC-4/file')
  ok(r.status === 409, 'archivo sin descargar → 409')
  r = await fetch(base + '/api/documents/NOEXISTE/file')
  ok(r.status === 404, 'id inexistente → 404')
  // ruta fuera de la carpeta de descargas → 403
  store.update('TESTDOC-5', { status: 'downloaded', path: 'C:\\Windows\\System32\\notepad.exe' })
  r = await fetch(base + '/api/documents/TESTDOC-5/file')
  store.update('TESTDOC-5', { status: 'pending', path: null })
  ok(r.status === 403, 'archivo fuera de downloadsDir → 403')
}

console.log('\n[14] Historial tras "reinicio" (el store debe recargar desde disco)')
{
  const antes = store.list().map((d) => d.id)
  store.load() // simula el arranque nuevo (index.js main llama a store.load())
  const despues = store.list().map((d) => d.id)
  ok(JSON.stringify(antes) === JSON.stringify(despues) && despues.length === 5,
    `reinicio simulado: se recuperan ${despues.length} documentos (${despues.join(', ')})`)
  store.chatLoad()
  ok(store.chatMessages('5491155555555@s.whatsapp.net', 3).length === 3, 'chatlog recuperado tras reinicio')
}

console.log('\n[15] Idempotencia: historial + catch-up + tiempo real pueden repetir el mismo mensaje')
{
  const jid = '5491155555555@s.whatsapp.net'
  const antes = store.list().length
  store.add(registro('TESTDOC-1', 'Informe.pdf')) // mismo id que ya existía
  ok(store.list().length === antes, 'store.add con id existente no duplica (historial = catch-up)')

  const n = store.chatMessages(jid, 50).length
  store.chatAdd({ id: 'CT-24', remoteJid: jid, ts: new Date().toISOString(), kind: 'texto', text: 'repetido' })
  ok(store.chatMessages(jid, 50).length === n, 'chatAdd con id existente no duplica')
  store.chatAdd({ id: 'CT-HIST-1', remoteJid: jid, ts: new Date(2023, 0, 1).toISOString(), kind: 'documento', text: 'documento del historial', filename: 'viejo.pdf', mime: 'application/pdf' })
  const lista = store.chatMessages(jid, 50)
  ok(lista.some((m) => m.id === 'CT-HIST-1') && lista.filter((m) => m.id === 'CT-HIST-1').length === 1,
    'mensaje que llega por el historial se registra una sola vez')
}

console.log('\n[16] Log de diagnóstico (botón "Logs" de la web)')
{
  const diag = await import('../src/diag.js')
  diag.dbg('TEST: línea de diagnóstico')
  const r = await api('/api/debug-log')
  ok(r.status === 200 && Array.isArray(r.data.lines), `GET /api/debug-log → ${r.status}, ${r.data.lines?.length || 0} líneas`)
  ok(r.data.lines.some((l) => l.includes('TEST: línea de diagnóstico')), 'la línea escrita aparece en el log')
  ok(typeof r.data.file === 'string' && fs.existsSync(r.data.file), `archivo del log visible: ${r.data.file}`)
}

console.log('\n[17] Nombres de contacto (remitente legible en historial @lid)')
{
  store.contactosSet('5491155555555@s.whatsapp.net', 'Juan Pérez')
  store.contactosSet('92535791870140@lid', 'Juan Pérez')
  ok(store.contactosGet('92535791870140@lid') === 'Juan Pérez', 'contactosGet resuelve el @lid')
  ok(store.contactosGet('inexistente@x') === '', 'contactosGet sin dato → ""')

  // Registro viejo guardado con el jid: la API debe resolver el nombre.
  store.update('TESTDOC-1', { from: '92535791870140@lid' })
  const r = await api('/api/documents?limit=25&offset=0')
  const d = r.data.documents.find((x) => x.id === 'TESTDOC-1')
  ok(d.from === 'Juan Pérez', `publico resuelve el nombre del contacto: ${d.from}`)

  store.contactosLoad() // reinicio simulado
  ok(store.contactosGet('92535791870140@lid') === 'Juan Pérez', 'contactos persistidos tras reinicio')
}

server.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${fallos === 0 ? 'SIMULACIÓN OK — todas las comprobaciones pasaron' : `SIMULACIÓN CON ${fallos} FALLOS`}`)
process.exit(fallos === 0 ? 0 : 1)
