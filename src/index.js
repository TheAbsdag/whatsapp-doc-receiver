// Arranque: servidor HTTP plano (sin frameworks) + conexión Baileys en el
// MISMO proceso Node. Escucha SOLO en 127.0.0.1 (loopback).
//
// API:
//   GET  /api/status            → { connected, loggedIn, requiresQr, lastMessageAt }
//   GET  /api/qr                → { qrBase64 } (PNG) | 404
//   GET  /api/documents         → { documents, total, offset, limit } (paginado)
//   POST /api/documents/:id/download → { ok, fileName, path } | 404/500
//   GET  /api/documents/:id/file    → sirve el archivo descargado (vista previa) | 404/409/403
//   POST /api/documents/:id/print    → { ok, message } | 404/409/500
//   GET  /api/chat/:jid/messages → { chat, messages: [...] } contexto del chat
//   GET  /api/debug-log          → { file, lines } últimas líneas del log de diagnóstico
//   GET/POST /api/printer       → leer/guardar el nombre de impresora
//   GET  /api/printers          → { printers: [...] } del sistema (lpstat -a)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import QRCode from 'qrcode'
import * as baileys from './baileys.js'
import * as store from './store.js'
import { readJson, writeJsonAtomic, saveDownload, sanitizeFilename } from './files.js'
import { printDocument, listPrinters } from './printer.js'
import { dbg, debugInit, leerUltimas, DEBUG_FILE } from './diag.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const WEB_DIR = path.join(ROOT, 'src', 'web')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const STATE_FILE = path.join(store.DATA_DIR, 'state.json')

const DEFAULT_CONFIG = {
  port: 8787,
  host: '127.0.0.1',
  downloadsDir: '~/WhatsAppDocs',
  printer: '',
}

const STATIC_FILES = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
}

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
}

const EXT_POR_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/plain': 'txt',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
}

// Tipos de contenido para servir archivos (vista previa en el navegador).
const ARCHIVO_MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

// ---------------------------------------------------------------------------
// Configuración (config.json opcional; valores por defecto en este archivo)
// ---------------------------------------------------------------------------

function expandHome(p) {
  const s = String(p || '')
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(os.homedir(), s.slice(2))
  }
  return s
}

export function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) }
  cfg.downloadsDir = expandHome(cfg.downloadsDir)
  return cfg
}

/** Persiste en config.json las claves que el usuario puede editar. */
export function saveConfig(cfg, patch) {
  Object.assign(cfg, patch)
  const raw = readJson(CONFIG_FILE, {})
  writeJsonAtomic(CONFIG_FILE, {
    port: cfg.port,
    host: cfg.host,
    downloadsDir: raw.downloadsDir ?? cfg.downloadsDir,
    printer: cfg.printer,
    ...(raw.lpBin ? { lpBin: raw.lpBin } : {}),
    ...(Array.isArray(raw.lpArgsPrefix) ? { lpArgsPrefix: raw.lpArgsPrefix } : {}),
  })
}

// ---------------------------------------------------------------------------
// Estado liviano (último mensaje recibido) en data/state.json
// ---------------------------------------------------------------------------

let lastMessageAt = readJson(STATE_FILE, {}).lastMessageAt || null

function saveState() {
  writeJsonAtomic(STATE_FILE, { lastMessageAt })
}

// ---------------------------------------------------------------------------
// Utilidades de mensajes
// ---------------------------------------------------------------------------

function marcaTiempo() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function extParaMime(mime) {
  if (EXT_POR_MIME[mime]) return EXT_POR_MIME[mime]
  const sub = String(mime || '').split('/')[1] || ''
  const limpio = sanitizeFilename(sub)
  return limpio && limpio.length <= 8 && limpio !== 'octet-stream' ? limpio : 'bin'
}

/** Nombre visible del registro: saneado, con extensión garantizada. */
function makeFilename(info) {
  let name = sanitizeFilename(info.filename || '')
  if (!name) name = `${info.kind}_${marcaTiempo()}`
  if (!path.extname(name)) name = `${name}.${extParaMime(info.mime)}`
  return name
}

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = ''
    req.on('data', (c) => {
      datos += c
      if (datos.length > 64 * 1024) {
        req.destroy()
        reject(new Error('Cuerpo demasiado grande'))
      }
    })
    req.on('end', () => {
      try {
        resolve(datos ? JSON.parse(datos) : {})
      } catch {
        reject(new Error('JSON inválido'))
      }
    })
    req.on('error', reject)
  })
}

/** Vista pública de un registro (sin el mensaje crudo de WhatsApp). */
function publico(d) {
  return {
    id: d.id,
    remoteJid: d.remoteJid,
    from: d.from,
    direction: d.direction || 'received', // 'sent' = enviado desde el teléfono vinculado
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    caption: d.caption,
    receivedAt: d.receivedAt,
    status: d.status,
  }
}

/**
 * Crea la app HTTP. `api` (inyectable para tests) debe exponer:
 *   getStatus(), getQrString(), downloadMedia(message)
 */
export function createApp({ config, api } = {}) {
  const cfg = config || loadConfig()
  const iface = api || baileys

  return http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      const p = u.pathname

      // --- estáticos (whitelist: solo los tres archivos del proyecto)
      if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, p)) {
        const archivo = path.join(WEB_DIR, STATIC_FILES[p])
        const cuerpo = await fs.promises.readFile(archivo)
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(archivo).slice(1)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        return res.end(cuerpo)
      }

      // --- API
      if (req.method === 'GET' && p === '/api/status') {
        return json(res, 200, { ...iface.getStatus(), lastMessageAt })
      }

      if (req.method === 'GET' && p === '/api/qr') {
        const qr = iface.getQrString()
        if (!qr) return json(res, 404, { error: 'No hay QR pendiente' })
        const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 })
        return json(res, 200, { qrBase64: dataUrl.replace(/^data:image\/png;base64,/, '') })
      }

      if (req.method === 'GET' && p === '/api/documents') {
        const q = u.searchParams
        const limit = Math.min(200, Math.max(1, parseInt(q.get('limit') || '25', 10) || 25))
        const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0)
        const todos = store.list()
        const base = q.get('order') === 'asc' ? [...todos].reverse() : todos
        return json(res, 200, {
          documents: base.slice(offset, offset + limit).map(publico),
          total: todos.length,
          offset,
          limit,
        })
      }

      const mc = p.match(/^\/api\/chat\/([^/]+)\/messages$/)
      if (req.method === 'GET' && mc) {
        const jid = decodeURIComponent(mc[1])
        const limit = Math.min(50, Math.max(1, parseInt(u.searchParams.get('limit') || '20', 10) || 20))
        return json(res, 200, { chat: jid, messages: store.chatMessages(jid, limit) })
      }

      if (req.method === 'GET' && p === '/api/debug-log') {
        return json(res, 200, { file: DEBUG_FILE, lines: leerUltimas(120) })
      }

      if (req.method === 'GET' && p === '/api/printer') {
        return json(res, 200, { printer: cfg.printer || '' })
      }

      if (req.method === 'GET' && p === '/api/printers') {
        const r = await listPrinters(cfg)
        return json(res, 200, r)
      }

      if (req.method === 'POST' && p === '/api/printer') {
        const cuerpo = await leerCuerpo(req)
        cfg.printer = String(cuerpo.printer ?? '').trim()
        if (cfg.persistConfig !== false) saveConfig(cfg, {})
        return json(res, 200, { ok: true, printer: cfg.printer })
      }

      const m = p.match(/^\/api\/documents\/([^/]+)\/(download|print|file)$/)
      if (req.method === 'POST' && m && m[2] !== 'file') {
        const id = decodeURIComponent(m[1])
        const doc = store.get(id)
        if (!doc) return json(res, 404, { error: 'Documento no encontrado' })

        if (m[2] === 'download') {
          try {
            const buffer = await iface.downloadMedia(doc.message)
            const salida = saveDownload(buffer, cfg.downloadsDir, doc.filename)
            store.update(id, { status: 'downloaded', path: salida, downloadedAt: new Date().toISOString() })
            dbg(`API descarga OK: ${doc.filename} → ${salida}`)
            return json(res, 200, { ok: true, fileName: path.basename(salida), path: salida })
          } catch (e) {
            dbg(`ERROR API descarga ${id} (${doc.filename}):`, e?.stack || String(e))
            return json(res, 500, { error: `No se pudo descargar: ${e.message}` })
          }
        }

        // --- print
        if (doc.status !== 'downloaded' || !doc.path) {
          dbg(`API print rechazado ${id}: aún no descargado`)
          return json(res, 409, { error: 'El documento aún no está descargado' })
        }
        const resultado = await printDocument(doc.path, cfg)
        if (!resultado.ok) dbg(`ERROR API print ${id} (${doc.filename}):`, resultado.message)
        return json(res, resultado.ok ? 200 : 500, resultado)
      }

      // --- vista previa: sirve el archivo descargado (solo desde downloadsDir)
      if (req.method === 'GET' && m && m[2] === 'file') {
        const id = decodeURIComponent(m[1])
        const doc = store.get(id)
        if (!doc) return json(res, 404, { error: 'Documento no encontrado' })
        if (doc.status !== 'downloaded' || !doc.path) {
          return json(res, 409, { error: 'El documento aún no está descargado' })
        }
        const base = path.resolve(cfg.downloadsDir)
        const ruta = path.resolve(doc.path)
        if (ruta !== base && !ruta.startsWith(base + path.sep)) {
          return json(res, 403, { error: 'El archivo está fuera de la carpeta de descargas' })
        }
        try {
          const stat = await fs.promises.stat(ruta)
          const tipo = ARCHIVO_MIME[path.extname(ruta).toLowerCase()] || 'application/octet-stream'
          res.writeHead(200, {
            'Content-Type': tipo,
            'Content-Length': stat.size,
            'Content-Disposition': 'inline',
            'Cache-Control': 'no-store',
          })
          fs.createReadStream(ruta).pipe(res)
          return
        } catch (e) {
          return json(res, 404, { error: `El archivo ya no existe: ${e.message}` })
        }
      }

      if (p === '/favicon.ico') {
        res.writeHead(204)
        return res.end()
      }

      return json(res, 404, { error: 'No encontrado' })
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  })
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function main() {
  debugInit(`whatsapp-doc-receiver (proceso ${process.pid})`)
  const config = loadConfig()
  // Recuperar el historial persistido: documentos y contexto de chats
  // (si no se carga aquí, tras un reinicio la lista aparece vacía).
  store.load()
  store.chatLoad()
  dbg('Arranque:', {
    host: config.host,
    port: config.port,
    downloadsDir: config.downloadsDir,
    printer: config.printer || '(por defecto)',
    documentosEnDisco: store.list().length,
    mensajesDeContextoEnDisco: store.chatCount(),
  })

  // Errores no capturados: que queden en el log de diagnóstico (la UI muestra
  // el botón "Logs") y no se pierdan en la nada.
  process.on('uncaughtException', (e) => dbg('ERROR GLOBAL uncaughtException:', e?.stack || String(e)))
  process.on('unhandledRejection', (e) => dbg('ERROR GLOBAL unhandledRejection:', e?.stack || String(e)))

  const app = createApp({ config })
  app.listen(config.port, config.host, () => {
    console.log(`whatsapp-doc-receiver escuchando en http://${config.host}:${config.port}`)
    console.log(`Descargas en: ${config.downloadsDir}`)
  })

  baileys.start({
    onMessage: () => {
      lastMessageAt = new Date().toISOString()
      saveState()
    },
    onChatMessage: (_msg, info) => {
      store.chatAdd({
        id: _msg.key.id,
        remoteJid: info.remoteJid,
        fromMe: info.fromMe,
        ts: info.ts,
        kind: info.kind,
        text: info.text,
        filename: info.filename,
        mime: info.mime,
      })
    },
    onDocument: (msg, info) => {
      const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
      const record = {
        id: msg.key.id,
        remoteJid: msg.key.remoteJid || '',
        from: info.from,
        direction: msg.key.fromMe ? 'sent' : 'received',
        filename: makeFilename(info),
        mime: info.mime,
        size: info.size,
        caption: info.caption,
        receivedAt: new Date(ts).toISOString(), // fecha del mensaje (no de llegada al registro)
        status: 'pending',
        path: null,
        message: msg, // necesario para re-descargar la media más tarde
      }
      store.add(record)
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
