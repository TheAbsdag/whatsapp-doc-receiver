// Registro persistente de documentos recibidos: data/documents.json
// Log de contexto por chat: data/chatlog.json (últimos mensajes por chat).
// Cada documento conserva ademas su ventana de contexto (4 mensajes antes +
// hasta 4 despues) para que el panel muestre el entorno del archivo, no solo
// el final del chat.
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
// Ventana de contexto por documento: 4 mensajes ANTES + hasta 4 DESPUÉS
// ---------------------------------------------------------------------------

const CONTEXTO_ANTES = 4
const CONTEXTO_DESPUES = 4

/**
 * Vista completa del chat: mensajes guardados bajo TODAS las claves del mismo
 * contacto (teléfono + @lid + alias), deduplicados por id y ordenados por
 * fecha. Últimos `max`. A diferencia de chatMessages (que solo mira una
 * clave), esto une las formas que WhatsApp usa para el mismo chat.
 */
export function chatVentana(jid, max = 50) {
  const claves = new Set([jid, ...aliasDe(jid)])
  const vistos = new Set()
  const todos = []
  for (const k of claves) {
    for (const m of chat[k] || []) {
      if (vistos.has(m.id)) continue
      vistos.add(m.id)
      todos.push(m)
    }
  }
  todos.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
  return todos.slice(-max)
}

/**
 * Snapshot de los hasta CONTEXTO_ANTES mensajes que preceden al documento
 * `idDoc`. Se llama al registrar el documento: el log ya contiene el propio
 * mensaje del documento (lo agrega chatAdd justo antes), así que se saca de
 * la ventana. El documento siempre termina con contexto guardado (aunque
 * vacío), para que los mensajes posteriores tengan dónde sumarse.
 */
export function contextoInicial(jid, idDoc) {
  const ventana = chatVentana(jid, CONTEXTO_ANTES + 5)
  const i = ventana.findIndex((m) => m.id === idDoc)
  if (i >= 0) return ventana.slice(Math.max(0, i - CONTEXTO_ANTES), i)
  return ventana.slice(-CONTEXTO_ANTES)
}

/**
 * Un mensaje recién llegado se suma como "después" (tope CONTEXTO_DESPUES)
 * a los documentos del mismo chat que ya tienen contexto: mensajes con fecha
 * posterior al documento, sin repetir id ni contarse a sí mismos (la vía
 * repetida historial/catch-up re-despacha). Devuelve cuántos se actualizaron.
 */
export function contextoDespuesAgregar(jid, msg) {
  let actualizados = 0
  for (const d of docs) {
    if (!d.contexto || !Array.isArray(d.contexto.despues)) continue
    const despues = d.contexto.despues
    if (despues.length >= CONTEXTO_DESPUES) continue
    if (msg.id && (msg.id === d.id || despues.some((m) => m.id === msg.id))) continue
    // Solo mensajes con fecha igual o posterior al documento (los previos
    // tienen la misma cifra de segundos y llegan antes por despacho).
    if (msg.ts && d.receivedAt && String(msg.ts) < String(d.receivedAt)) continue
    if (!mismoChat(jid, d.remoteJid)) continue
    despues.push({ ...msg })
    actualizados++
  }
  if (actualizados) save()
  return actualizados
}

/** ¿Dos jids corresponden al mismo chat? (formas teléfono/@lid del mismo contacto) */
export function mismoChat(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const aliasB = aliasDe(b)
  if (aliasB.includes(a)) return true
  for (const x of aliasDe(a)) {
    if (x === b || aliasB.includes(x)) return true
  }
  return false
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
