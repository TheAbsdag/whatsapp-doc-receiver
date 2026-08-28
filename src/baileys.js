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

const logger = pino({ level: 'warn' })

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
  return {
    kind: img ? 'imagen' : 'documento',
    filename: doc ? String(m.fileName || '') : '',
    mime: m.mimetype || (img ? 'image/jpeg' : 'application/octet-stream'),
    size: Number(m.fileLength || 0),
    caption: String(m.caption || m.captions?.[0]?.caption || ''),
    from: msg.pushName || msg.participant || msg.key.remoteJid || '',
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
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try {
    version = (await fetchLatestBaileysVersion()).version
  } catch {
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

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

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
      logger.info('WhatsApp conectado')
    } else if (connection === 'close') {
      estado.connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      const desvinculado = code === DisconnectReason.loggedOut

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
  const despachar = (messages) => {
    for (const msg of messages) {
      if (handlers.onChatMessage && esContexto(msg)) {
        const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
        handlers.onChatMessage(msg, {
          remoteJid: msg.key.remoteJid || '',
          fromMe: !!msg.key.fromMe,
          ts: new Date(ts).toISOString(),
          ...extraerChat(msg),
        })
      }
      const info = extraerDocumento(msg)
      if (info && handlers.onDocument) {
        handlers.onDocument(msg, info)
      }
    }
  }

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // A: 'append' = mensajes acumulados mientras el socket estuvo caído
    // (catch-up "offline" al reconectar) y notificaciones; 'notify' =
    // mensajes nuevos en tiempo real. Antes solo se veía 'notify' y los
    // documentos recibidos con el equipo apagado se perdían.
    if (type !== 'notify' && type !== 'append') return
    if (handlers.onMessage) handlers.onMessage()
    despachar(messages)
  })

  // B: historial sincronizado que el teléfono envía al vincular un dispositivo
  // (y, en algunos casos, en reconexiones). No se toca lastMessageAt: son
  // mensajes antiguos, no llegadas nuevas.
  sock.ev.on('messaging-history.set', ({ messages }) => {
    if (Array.isArray(messages) && messages.length) despachar(messages)
  })
}

function reconectar(handlers) {
  clearTimeout(timerReconexion)
  intento++
  // backoff simple: 2s, 4s, 8s… máx 30s. La app reinicia la conexión sola
  // (además del Restart del servicio systemd si llegara a caerse el proceso).
  const retraso = Math.min(30_000, 1000 * 2 ** Math.min(intento, 5))
  logger.warn(`Reconectando en ${Math.round(retraso / 1000)} s (intento ${intento})`)
  timerReconexion = setTimeout(() => {
    conectar(handlers).catch((err) => {
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
  conectar(handlers).catch((err) => {
    logger.error({ err }, 'Error al iniciar Baileys; se reintentará')
    reconectar(handlers)
  })
}
