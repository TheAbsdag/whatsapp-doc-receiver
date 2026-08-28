// Utilidades de archivos: escritura JSON atómica, saneado de nombres,
// descarga de archivos sin colisiones. Solo stdlib.
import fs from 'node:fs'
import path from 'node:path'

// Caracteres prohibidos en nombres de archivo (path separators, reservados de
// Windows y caracteres de control). En Linux solo '/' y NUL son inválidos,
// pero limpiar también los reservados evita sorpresas al copiar archivos.
const CARACTERES_INVALIDOS = /[\/\\:*?"<>|\u0000-\u001f\u007f]/g

/**
 * Devuelve un nombre de archivo seguro: sin separadores de ruta, sin
 * caracteres de control, sin puntos iniciales (archivos ocultos) y con
 * longitud acotada. Nunca devuelve una cadena vacía.
 */
export function sanitizeFilename(name) {
  let n = String(name ?? '')
    .normalize('NFC')
    .replace(CARACTERES_INVALIDOS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return n || 'documento'
}

/**
 * Ruta libre de colisiones: si `dir/name` ya existe, agrega " (1)", " (2)"…
 * antes de la extensión.
 */
export function uniquePath(dir, name) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length) || 'documento'
  let candidate = path.join(dir, name)
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`)
  }
  return candidate
}

/**
 * Guarda un buffer en `dir` con nombre saneado y sin colisiones.
 * Escritura atómica: archivo temporal + rename, para no dejar archivos a medias.
 * Devuelve la ruta final absoluta.
 */
export function saveDownload(buffer, dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  const finalPath = uniquePath(dir, sanitizeFilename(name))
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${process.pid}.tmp`)
  fs.writeFileSync(tmpPath, buffer)
  fs.renameSync(tmpPath, finalPath)
  return finalPath
}

/** Escritura atómica de JSON: .tmp + rename. Crea el directorio si falta. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

/** Lee JSON; ante cualquier error (o archivo inexistente) devuelve `fallback`. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
