// Registro persistente de documentos recibidos: data/documents.json
// Escritura atómica (files.writeJsonAtomic) — nada de bases de datos.
// El directorio de datos puede sobreescribirse con la variable de entorno
// WHATSAPP_DOC_RECEIVER_DATA_DIR (útil para tests y data dirs alternativos).
import path from 'node:path'
import { readJson, writeJsonAtomic } from './files.js'

export const DATA_DIR = path.resolve(process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR || 'data')
export const FILE = path.join(DATA_DIR, 'documents.json')

let docs = [] // más recientes primero

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
