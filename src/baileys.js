// Conexión a WhatsApp Web vía Baileys (protocolo no oficial).
// - Sesión persistente en data/auth (no vuelve a pedir QR salvo desvinculación).
// - Reconexión automática ante 'close' con backoff; QR fresco si la sesión se
//   desvincula (DisconnectReason.loggedOut → se limpia data/auth).
// - Mensajes: se procesan 'notify' (tiempo real) Y 'append' (catch-up de lo
//   recibido con el equipo apagado al reconectar) + 'messaging-history.set'
//   (historial que el teléfono envía al vincular). Todo se deduplica por id.
// - El keep-alive / autoping de la conexión lo maneja Baileys internamente
//   (ping periódico del WebSocket), no hay que hacer nada extra.
// - Logs tranquilos: pino en nivel 'warn'.
import fs from 'node:fs'
import path from 'node:path'
import pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { dbg } from './diag.js'
import { contactosGet, contactosSet } from './store.js'

const DATA_DIR = path.resolve(process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR || 'data')
const BAIL_LOGFILE = path.join(DATA_DIR, 'baileys.log')
fs.mkdirSync(DATA_DIR, { recursive: true })
// Pino interno de Baileys a ARCHIVO (JSON): los warnings/errores del protocolo
// (p. ej. fallo al descargar el blob de historial) quedan visibles.
const logger = pino(
  { level: process.env.WHATSAPP_DOC_RECEIVER_LOG_LEVEL || 'warn' },
  pino.destination(BAIL_LOGFILE),
)

const AUTH_DIR = path.resolve(process.env.WHATSAPP_DOC_RECEIVER_AUTH_DIR || 'data/auth')

const estado = {
  connected: false, // conexión WebSocket abierta
  loggedIn: false, // sesión enlazada (credenciales válidas)
  requiresQr: true, // hay que vincular/re-vincular desde el teléfono
  qrString: null, // último QR pendiente (cadena que escanea el teléfono)
}

let sock = null
let intento = 0
let timerReconexion = null

export function getStatus() {
  return {
    connected: estado.connected,
    loggedIn: estado.loggedIn,
    requiresQr: estado.requiresQr,
  }
}

export function getQrString() {
  return estado.qrString
}

/**
 * Descarga la media de un mensaje (documento o imagen) y devuelve el buffer.
 * `reuploadRequest` permite a Baileys re-subir la media si el servidor la
 * expiró (solo funciona mientras la clave del mensaje siga siendo válida).
 */
export async function downloadMedia(message) {
  if (!sock) throw new Error('Sin conexión con WhatsApp')
  return downloadMediaMessage(message, 'buffer', {}, {
    logger,
    ...(sock.updateMediaMessage
      ? { reuploadRequest: (msg) => sock.updateMediaMessage(msg) }
      : {}),
  })
}

/** Extrae la info de un documento/imagen; devuelve null para el resto. */
function extraerDocumento(msg) {
  const doc = msg.message?.documentMessage
  const img = msg.message?.imageMessage
  const m = doc || img
  if (!m) return null
  const jid = msg.key?.remoteJid || ''
  return {
    kind: img ? 'imagen' : 'documento',
    filename: doc ? String(m.fileName || '') : '',
    mime: m.mimetype || (img ? 'image/jpeg' : 'application/octet-stream'),
    size: Number(m.fileLength || 0),
    caption: String(m.caption || m.captions?.[0]?.caption || ''),
    // Apodo del mensaje → nombre guardado del contacto (historial trae @lid sin
    // pushName) → participante → jid: así se muestra un nombre legible.
    from: msg.pushName || contactosGet(jid) || msg.participant || jid,
  }
}

/** Info mínima de cualquier mensaje (texto, documento o imagen) para el contexto del chat. */
function extraerChat(msg) {
  const m = msg.message || {}
  const doc = m.documentMessage
  const img = m.imageMessage
  const media = doc || img
  const text = String(m.conversation || m.extendedTextMessage?.text || m.caption || '')
  return {
    kind: media ? (img ? 'imagen' : 'documento') : text ? 'texto' : 'otro',
    text,
    filename: doc ? String(doc.fileName || '') : '',
    mime: media ? String(media.mimetype || '') : '',
  }
}

/**
 * ¿Es un mensaje con contenido de chat (texto, documento o imagen)?
 * Filtra protocolMessage (sincronización, revocaciones, ediciones), reacciones,
 * llamadas y demás ruido que llega por 'append' y por el historial.
 */
function esContexto(msg) {
  const m = msg?.message || null
  if (!m || m.protocolMessage) return false
  return !!(m.conversation || m.extendedTextMessage || m.documentMessage || m.imageMessage)
}

async function conectar(handlers) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  dbg('BAILEYS conectar(): sesión en', AUTH_DIR)
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try {
    version = (await fetchLatestBaileysVersion()).version
    dbg('BAILEYS versión Baileys:', version?.join('.') || 'desconocida')
  } catch (e) {
    dbg('BAILEYS advertencia: no se pudo consultar la versión de Baileys:', e?.message)
    logger.warn('No se pudo consultar la versión de Baileys; se usará la por defecto')
  }

  sock = makeWASocket({
    version: Array.isArray(version) ? version : undefined,
    auth,
    logger,
    generateHighQualityLinkPreview: false, // ahorra procesamiento/RAM
    // B: acepta la sincronización de historial que el teléfono ofrezca al
    // vincular (por defecto Baileys la descarta con syncFullHistory:false).
    // NO se pide historial completo (requireFullSync sigue en false): solo se
    // registra lo que WhatsApp decida compartir (INITIAL_BOOTSTRAP/RECENT).
    shouldSyncHistoryMessage: () => true,
  })

  sock.ev.on('creds.update', saveCreds)

  // Nombres visibles de contactos (para mostrar remitente legible incluso en
  // mensajes @lid del historial/catch-up, que no traen pushName).
  const guardarContacto = (c) => {
    if (!c || !c.id) return
    const nombre = c.name || c.notify || c.verifiedName || ''
    if (!nombre) return
    contactosSet(c.id, nombre)
    if (c.lid) contactosSet(c.lid, nombre)
    if (c.jid) contactosSet(c.jid, nombre)
  }
  sock.ev.on('contacts.update', (lista) => { for (const c of lista) guardarContacto(c) })
  sock.ev.on('contacts.upsert', (lista) => { for (const c of lista) guardarContacto(c) })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    const estadoMsg = connection
      ? `conexión=${connection}`
      : qr ? 'qr=nuevo' : `actualización=${Object.keys(update).join(',')}`
    dbg('BAILEYS connection.update:', estadoMsg)

    if (qr) {
      estado.qrString = qr
      estado.requiresQr = true
    }

    if (connection === 'open') {
      intento = 0
      estado.connected = true
      estado.loggedIn = true
      estado.requiresQr = false
      estado.qrString = null
      dbg('BAILEYS conectado a WhatsApp')
      logger.info('WhatsApp conectado')
    } else if (connection === 'close') {
      estado.connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      const desvinculado = code === DisconnectReason.loggedOut
      dbg('BAILEYS conexión cerrada:', { estado: lastDisconnect?.error?.message || 'sin detalle', code, desvinculado })

      if (desvinculado) {
        logger.warn('Sesión desvinculada desde el teléfono: se requiere un QR nuevo')
        estado.loggedIn = false
        estado.requiresQr = true
        estado.qrString = null
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        } catch {
          // sin permisos u otro problema: el QR nuevo se puede pedir igual
        }
        intento = 0
      }
      reconectar(handlers)
    }
  })

  // Despacha una lista de mensajes a los handlers: documentos al registro y
  // contexto del chat al log acotado. Los dos stores se deduplican por id, así
  // que es seguro que un mismo mensaje llegue por varias vías (historial,
  // catch-up y tiempo real).
  const despachar = (messages, origen) => {
    for (const msg of messages) {
      try {
        const id = msg?.key?.id || '(sin id)'
        const jid = msg?.key?.remoteJid || '(sin jid)'

        // ¿Notificación de historial de WhatsApp? Log del antes/después: si se
        // ve aquí pero NO llega 'messaging-history.set', el fallo es interno de
        // Baileys (descarga/descifrado del blob).
        const histNotif = msg?.message?.protocolMessage?.historySyncNotification
        if (histNotif) {
          dbg(`BAILEYS [${origen}] notificación de SINCRONIZACIÓN DE HISTORIAL recibida:`, {
            syncType: histNotif.syncType,
            id,
            jid,
          })
        }

        const infoDoc = extraerDocumento(msg)
        if (handlers.onChatMessage && esContexto(msg)) {
          const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
          const ch = extraerChat(msg)
          handlers.onChatMessage(msg, {
            remoteJid: jid,
            participant: msg.key?.participant || '',
            fromMe: !!msg.key.fromMe,
            ts: new Date(ts).toISOString(),
            ...ch,
          })
          dbg(`BAILEYS [${origen}] contexto:`, { id, jid, kind: ch.kind, filename: ch.filename || '', texto: ch.text.slice(0, 80) })
        } else if (!infoDoc) {
          dbg(`BAILEYS [${origen}] mensaje SIN contenido registrable:`, { id, jid, tieneProtocolo: !!(msg?.message?.protocolMessage) })
        }

        if (infoDoc && handlers.onDocument) {
          handlers.onDocument(msg, infoDoc)
          dbg(`BAILEYS [${origen}] DOCUMENTO registrado:`, { id, jid, filename: infoDoc.filename, mime: infoDoc.mime, size: infoDoc.size, fromMe: !!msg.key.fromMe })
        }
      } catch (e) {
        dbg(`ERROR BAILEYS [${origen}] procesando mensaje ${msg?.key?.id || '?'}:`, e?.stack || String(e))
      }
    }
  }

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // A: 'append' = mensajes acumulados mientras el socket estuvo caído
    // (catch-up "offline" al reconectar) y notificaciones; 'notify' =
    // mensajes nuevos en tiempo real. Antes solo se veía 'notify' y los
    // documentos recibidos con el equipo apagado se perdían.
    dbg(`BAILEYS messages.upsert:`, { type, cantidad: messages?.length || 0 })
    if (type !== 'notify' && type !== 'append') return
    if (handlers.onMessage) handlers.onMessage()
    despachar(messages, `upsert:${type}`)
  })

  // B: historial sincronizado que el teléfono envía al vincular un dispositivo
  // (y, en algunos casos, en reconexiones). No se toca lastMessageAt: son
  // mensajes antiguos, no llegadas nuevas.
  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress, syncType }) => {
    dbg('BAILEYS messaging-history.set RECIBIDO:', {
      chats: chats?.length || 0,
      contacts: contacts?.length || 0,
      messages: messages?.length || 0,
      syncType,
      progress,
      isLatest,
    })
    // El historial trae los nombres de los contactos: guardarlos antes de
    // registrar los mensajes, para que el remitente salga legible.
    for (const c of contacts || []) guardarContacto(c)
    if (Array.isArray(messages) && messages.length) despachar(messages, 'historial')
    else dbg('BAILEYS messaging-history.set sin mensajes (solo chats/contactos)')
  })
}

function reconectar(handlers) {
  clearTimeout(timerReconexion)
  intento++
  // backoff simple: 2s, 4s, 8s… máx 30s. La app reinicia la conexión sola
  // (además del Restart del servicio systemd si llegara a caerse el proceso).
  const retraso = Math.min(30_000, 1000 * 2 ** Math.min(intento, 5))
  dbg(`BAILEYS reconectando en ${Math.round(retraso / 1000)} s (intento ${intento})`)
  logger.warn(`Reconectando en ${Math.round(retraso / 1000)} s (intento ${intento})`)
  timerReconexion = setTimeout(() => {
    conectar(handlers).catch((err) => {
      dbg('ERROR BAILEYS al conectar (se reintentará):', err?.stack || String(err))
      logger.error({ err }, 'Error al conectar con Baileys')
      reconectar(handlers)
    })
  }, retraso)
}

/**
 * Arranca el proceso de conexión (una sola vez). handlers:
 *   onMessage()  → se dispara con cada mensaje nuevo (para lastMessageAt)
 *   onDocument(msg, info) → se dispara con cada documento/imagen recibida
 *   onChatMessage(msg, info) → se dispara con cada mensaje nuevo (contexto del chat)
 */
export function start(handlers = {}) {
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  estado.requiresQr = !fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
  estado.loggedIn = !estado.requiresQr
  dbg('BAILEYS start():', { requiereQr: estado.requiresQr, hayCreds: !estado.requiresQr, authDir: AUTH_DIR })
  conectar(handlers).catch((err) => {
    dbg('ERROR BAILEYS al iniciar (se reintentará):', err?.stack || String(err))
    logger.error({ err }, 'Error al iniciar Baileys; se reintentará')
    reconectar(handlers)
  })
}
