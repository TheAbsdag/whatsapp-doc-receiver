// Impresión y detección de impresoras — MULTIPLATAFORMA.
//
// Linux:  lp / lpstat (CUPS).           Regla: "lp -d <impresora> -- <ruta>".
// Windows: SumatraPDF (portable, headless) + "Get-Printer" de PowerShell.
//          Regla: "SumatraPDF.exe -silent -print-to <impresora> <ruta>".
//
// Siempre se usa spawn con argumentos (NUNCA exec + strings concatenadas:
// un nombre de archivo malicioso no debe llegar a un shell). En Windows el
// comando de PowerShell es una cadena FIJA (sin datos del usuario), y en
// SumatraPDF la ruta es absoluta (nunca empieza con '-'), así que no hacen
// falta comillas ni "--".
// La salida se captura redirigiendo a un archivo temporal (descriptores
// reales, sin tuberías), lo que además evita bloqueos en entornos restringidos.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ES_WINDOWS = process.platform === 'win32'

function capturaPath() {
  const dir = process.env.WHATSAPP_DOC_RECEIVER_TMP_DIR || os.tmpdir()
  return path.join(dir, `wdr-lp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`)
}

/**
 * Ejecuta un binario con argumentos y captura su salida.
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
function runBin(bin, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const archivoCaptura = capturaPath()
    let fd
    try {
      fs.mkdirSync(path.dirname(archivoCaptura), { recursive: true })
      fd = fs.openSync(archivoCaptura, 'w')
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: `No se pudo preparar la captura de salida: ${e.message}` })
      return
    }

    let fallo = null
    const child = spawn(bin, args, { stdio: ['ignore', fd, fd], timeout, windowsHide: true })

    child.on('error', (err) => {
      fallo = { ok: false, stdout: '', stderr: `No se pudo ejecutar ${bin}: ${err.message}` }
    })

    child.on('close', (code) => {
      try { fs.closeSync(fd) } catch { /* noop */ }
      const salida = (() => {
        try { return fs.readFileSync(archivoCaptura, 'utf8').trim() } catch { return '' }
      })()
      try { fs.rmSync(archivoCaptura, { force: true }) } catch { /* noop */ }

      if (fallo) return resolve(fallo)
      if (code === 0) resolve({ ok: true, stdout: salida, stderr: '' })
      else resolve({ ok: false, stdout: salida, stderr: salida || `${bin} falló (código ${code})` })
    })
  })
}

/** ¿Existe el binario en el PATH? (Windows: where.exe) */
function binDisponible(bin) {
  return new Promise((resolve) => {
    const probe = ES_WINDOWS ? 'where.exe' : 'sh'
    const args = ES_WINDOWS ? [bin] : ['-c', `command -v ${String(bin).replace(/[^a-zA-Z0-9_.-]/g, '')}`]
    const child = spawn(probe, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

// ---------------------------------------------------------------------------
// Impresión
// ---------------------------------------------------------------------------

/** Construye (bin, args) según plataforma y configuración. */
async function comandoImpresion(filePath, cfg) {
  const printer = cfg.printer || ''

  // 1) Sobreescritura explícita (tests o wrappers personalizados): mandato
  if (cfg.lpBin) {
    const prefix = Array.isArray(cfg.lpArgsPrefix) ? cfg.lpArgsPrefix : []
    return { bin: cfg.lpBin, args: [...prefix, ...(printer ? ['-d', printer] : []), '--', filePath] }
  }

  // 2) Windows: SumatraPDF portable (sin CUPS)
  if (ES_WINDOWS) {
    const pdfBin = cfg.pdfBin || 'SumatraPDF.exe'
    if (!(await binDisponible(pdfBin))) {
      return {
        error: `No se encontró ${pdfBin} (impresora de Windows). ` +
          `Descargá SumatraPDF portable y poné el exe en el PATH (o configurá "pdfBin" en config.json). ` +
          `La escritura y la web funcionan igual sin imprimir.`,
      }
    }
    const args = ['-silent']
    if (printer) args.push('-print-to', printer)
    else args.push('-print-to-default')
    args.push(filePath) // ruta absoluta: nunca empieza con '-', no requiere "--"
    return { bin: pdfBin, args }
  }

  // 3) Linux: lp de CUPS
  return { bin: 'lp', args: [...(printer ? ['-d', printer] : []), '--', filePath] }
}

/**
 * Imprime un archivo con lp (Linux/CUPS) o SumatraPDF (Windows).
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function printDocument(filePath, cfg) {
  const c = await comandoImpresion(filePath, cfg)
  if (c.error) return { ok: false, message: c.error }

  const r = await runBin(c.bin, c.args)
  if (r.ok) return { ok: true, message: r.stdout || 'Solicitud de impresión enviada' }
  const hint = ES_WINDOWS && /no se pudo ejecutar|falló/.test(r.stderr)
    ? ' Revisá que la impresora esté encendida y sea el nombre exacto de "Get-Printer".'
    : ' Revisá "lpstat -p" en la máquina.'
  return { ok: false, message: (r.stderr || 'falló la impresión') + hint }
}

// ---------------------------------------------------------------------------
// Detección de impresoras
// ---------------------------------------------------------------------------

/**
 * Lista las impresoras disponibles.
 * Linux: "lpstat -a". Windows: "Get-Printer" (comando PowerShell fijo, sin
 * datos del usuario). Errores devuelven { error }.
 * @returns {Promise<{printers: string[], error?: string}>}
 */
export async function listPrinters(cfg) {
  // 1) Sobreescritura explícita (tests): lpstat con lpBin/personalizado
  let r
  if (cfg.lpBin) {
    r = await runBin(cfg.lpBin, [
      ...(Array.isArray(cfg.lpArgsPrefix) ? cfg.lpArgsPrefix : []),
      '-a',
    ], { timeout: 10_000 })
  } else if (ES_WINDOWS) {
    // Comando fijo: Get-Printer | Select-Object -ExpandProperty Name
    r = await runBin('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name',
    ], { timeout: 15_000 })
    // Fallback sin WMI (algunos entornos restringen CIM): colas del registro
    if (!r.ok) {
      r = await runBin('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers" -ErrorAction SilentlyContinue | ForEach-Object { $_.PSChildName }',
      ], { timeout: 15_000 })
    }
  } else {
    r = await runBin('lpstat', ['-a'], { timeout: 10_000 })
  }
  if (!r.ok) return { printers: [], error: r.stderr || 'lpstat no disponible' }

  // Windows (Get-Printer/registro): una línea = nombre completo (puede llevar
  // espacios: "Microsoft Print to PDF"). CUPS: primera palabra = cola.
  const lineas = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  const nombres = (cfg.lpBin || !ES_WINDOWS)
    ? lineas.map((l) => l.split(/\s+/)[0]).filter((n) => !/^lpstat:/i.test(n) && n !== 'no')
    : lineas

  return { printers: [...new Set(nombres)].sort((a, b) => a.localeCompare(b)) }
}
