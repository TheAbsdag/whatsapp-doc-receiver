// Registro de diagnóstico en archivo: data/receptor-debug.log
// Líneas planas con timestamp (fáciles de leer y de pegar en un issue).
// Nunca debe romper la app: cualquier error de escritura se traga.
// Rotación simple: al superar ~1 MB el archivo pasa a .old y se sigue del cero.
import fs from 'node:fs'
import path from 'node:path'

export const DEBUG_FILE = process.env.WHATSAPP_DOC_RECEIVER_DEBUG_LOG
  ? path.resolve(process.env.WHATSAPP_DOC_RECEIVER_DEBUG_LOG)
  : path.resolve(process.env.WHATSAPP_DOC_RECEIVER_DATA_DIR || 'data', 'receptor-debug.log')

const MAX_BYTES = 1_000_000 // 1 MB

let escrito = false

function garantizarArchivo() {
  if (escrito) return
  fs.mkdirSync(path.dirname(DEBUG_FILE), { recursive: true })
  escrito = true
}

/** Escribe una línea de diagnóstico: dbg('mensaje', {clave: valor}) → JSON si no es string. */
export function dbg(...args) {
  try {
    garantizarArchivo()
    const texto = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
    const linea = `[${new Date().toISOString()}] ${texto}`
    fs.appendFileSync(DEBUG_FILE, linea + '\n')
    if (fs.statSync(DEBUG_FILE).size > MAX_BYTES) {
      fs.renameSync(DEBUG_FILE, DEBUG_FILE + '.old')
    }
  } catch {
    // el diagnóstico jamás debe tumbar la app
  }
}

/** Marca de inicio del proceso (hora y versión, para saber qué ejecutable corre). */
export function debugInit(marca = '') {
  dbg(`=== INICIO ${marca} → ${DEBUG_FILE} ===`)
}

/** Últimas `lineas` líneas del log, para la UI (GET /api/debug-log). */
export function leerUltimas(lineas = 80) {
  try {
    const texto = fs.readFileSync(DEBUG_FILE, 'utf8')
    const todas = texto.split('\n').filter((l) => l.trim())
    return todas.slice(-lineas)
  } catch {
    return [`(sin registros todavía: ${DEBUG_FILE})`]
  }
}
