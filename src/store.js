// Registro persistente de documentos recibidos: data/documents.json
// Log de contexto por chat: data/chatlog.json (últimos mensajes por chat).
// Escritura atómica (files.writeJsonAtomic) — nada de bases de datos.
// El directorio de datos puede sobreescribirse con la variable de entorno
// WHATSAPP_DOC_RECEIVER_DATA_DIR (útil para tests y data dirs alternativos).
import path from 'node:path'
import { readJson, writeJsonAtomic } from './files.js'

export const DATA_DIR = path.resolve(process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR || 'data')
export const FILE = path.join(DATA_DIR, 'documents.json')
const CHAT_FILE = path.join(DATA_DIR, 'chatlog.json')

const CHAT_POR_JID = 10 // últimos mensajes que se conservan por chat
const CHAT_MAX_TOTAL = 400 // tope global (40 chats con 10 mensajes, aprox.)

let docs = [] // más recientes primero
let chat = {} // jid → [msg, ...] más reciente primero

export function load() {
  const data = readJson(FILE, null)
  docs = Array.isArray(data) ? data : []
  if (!Array.isArray(data)) save()
  return docs
}

/** Lista en orden cronológico (más recientes primero); el cliente puede invertirlo. */
export function list() {
  return [...docs].sort(
    (a, b) =>
      String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')) ||
      String(b.id || '').localeCompare(String(a.id || '')),
  )
}

export function get(id) {
  return docs.find((d) => d.id === id)
}

/** Agrega un registro. Idempotente por id: si ya existe, no lo duplica. */
export function add(record) {
  const existente = get(record.id)
  if (existente) return existente
  docs.unshift(record)
  save()
  return record
}

/** Aplica un parche a un registro y persiste. Devuelve null si no existe. */
export function update(id, patch) {
  const doc = get(id)
  if (!doc) return null
  Object.assign(doc, patch)
  save()
  return doc
}

export function save() {
  writeJsonAtomic(FILE, docs)
}

// ---------------------------------------------------------------------------
// Log de contexto por chat (data/chatlog.json)
// ---------------------------------------------------------------------------

export function chatLoad() {
  const data = readJson(CHAT_FILE, null)
  chat = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  return chat
}

/**
 * Registra un mensaje de contexto. Idempotente por id; cada chat conserva a lo
 * sumo CHAT_POR_JID mensajes y el log global CHAT_MAX_TOTAL (se descartan los
 * más antiguos de los chats con menos actividad).
 */
export function chatAdd({ id, remoteJid, participant = '', fromMe = false, ts, kind = 'otro', text = '', filename = '', mime = '' }) {
  const jid = remoteJid || 'desconocido'
  const lista = chat[jid] || (chat[jid] = [])
  if (lista.some((m) => m.id === id)) return
  lista.unshift({ id, remoteJid: jid, participant, fromMe, ts, kind, text, filename, mime })
  if (lista.length > CHAT_POR_JID) lista.length = CHAT_POR_JID

  let total = Object.values(chat).reduce((n, l) => n + l.length, 0)
  while (total > CHAT_MAX_TOTAL) {
    const jidViejo = Object.keys(chat).sort((a, b) =>
      String(chat[a][0]?.ts || '').localeCompare(String(chat[b][0]?.ts || '')),
    )[0]
    if (!jidViejo) break
    chat[jidViejo].pop() // el más antiguo de ese chat (lista: más reciente primero)
    if (!chat[jidViejo].length) delete chat[jidViejo]
    total--
  }
  chatSave()
}

/**
 * Últimos `limit` mensajes de un chat, en orden cronológico (antiguo → reciente).
 * WhatsApp usa dos formas para el mismo chat (teléfono @s.whatsapp.net y @lid):
 * si la forma pedida no tiene mensajes, se buscan los ALIAS (claves del mapa de
 * contactos con el mismo nombre visible).
 */
export function chatMessages(jid, limit = 20) {
  let lista = chat[jid] || []
  for (const a of aliasDe(jid)) {
    if (lista.length) break
    lista = chat[a] || []
  }
  return [...lista.slice(0, limit)].reverse()
}

/** Otras claves del mapa de contactos que corresponden al mismo contacto. */
export function aliasDe(jid) {
  const alias = []
  if (!jid) return alias
  const nombre = contactos[jid]
  if (!nombre) return alias
  for (const [k, v] of Object.entries(contactos)) {
    if (k !== jid && v === nombre) alias.push(k)
  }
  return alias
}

/** Número total de mensajes de contexto guardados. */
export function chatCount() {
  return Object.keys(chat).reduce((n, j) => n + (chat[j]?.length || 0), 0)
}

export function chatSave() {
  writeJsonAtomic(CHAT_FILE, chat)
}

// ---------------------------------------------------------------------------
// Nombres visibles de contactos (data/contactos.json)
// El historial sincronizado trae { id, name, lid, jid } y las notificaciones en
// vivo traen { id, notify }: se guardan para mostrar el apodo/nombre del
// remitente aunque el mensaje venga SIN pushName (historial/catch-up con @lid).
// ---------------------------------------------------------------------------

const CONTACTOS_FILE = path.join(DATA_DIR, 'contactos.json')
const CONTACTOS_MAX = 1000

let contactos = {} // jid → nombre visible

export function contactosLoad() {
  const data = readJson(CONTACTOS_FILE, null)
  contactos = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  return contactos
}

/** Guarda un nombre visible bajo una clave (jid/lid/teléfono). */
export function contactosSet(jid, nombre) {
  if (!jid || !nombre) return false
  if (contactos[jid] === nombre) return false
  contactos[jid] = nombre
  const claves = Object.keys(contactos)
  if (claves.length > CONTACTOS_MAX) {
    for (const k of claves.slice(0, claves.length - CONTACTOS_MAX)) delete contactos[k]
  }
  contactosSave()
  return true
}

/** Nombre visible de un jid (o '' si no se conoce). */
export function contactosGet(jid) {
  return jid ? contactos[jid] || '' : ''
}

export function contactosSave() {
  writeJsonAtomic(CONTACTOS_FILE, contactos)
}

// ---------------------------------------------------------------------------
// Limpieza: documentos descargados cuya fecha (downloadedAt/receivedAt) es
// más vieja que `limiteMs` (0 = todos los descargados). Sólo selecciona; el
// borrado de archivos lo hace index.js (fs) con el guard de downloadsDir.
// ---------------------------------------------------------------------------

export function listaDescargados(limiteMs = 0) {
  const ahora = Date.now()
  return docs.filter((d) => {
    if (d.status !== 'downloaded' || !d.path) return false
    const ref = Date.parse(d.downloadedAt || d.receivedAt || '')
    if (Number.isNaN(ref)) return false
    return ahora - ref >= limiteMs
  })
}
