// Impresora simulada para el test (test/simulate.js).
// Se invoca como: node test/fake-lp.js [-d IMPRESORA] -- <archivo>
// también como lpstat: node test/fake-lp.js -a   (lista FAKE_LP_PRINTERS).
// Registra la invocación en FAKE_LP_LOG y, si FAKE_LP_FAIL=1, falla como la
// CUPS que reporta "la impresora no existe".
import fs from 'node:fs'

const args = process.argv.slice(2) // [ruta-de-este-script, -d, impresora, --, archivo]

if (process.env.FAKE_LP_LOG) {
  fs.appendFileSync(
    process.env.FAKE_LP_LOG,
    JSON.stringify({ at: new Date().toISOString(), args }) + '\n',
  )
}

// --- fallo simulado (CUPS rota): tiene prioridad, como un lp/lpstat real ----
if (process.env.FAKE_LP_FAIL === '1') {
  process.stderr.write('lp: La impresora no existe o no está encendida\n')
  process.exit(3)
}

// --- modo lpstat -a ---------------------------------------------------------
if (args.includes('-a')) {
  const lista = (process.env.FAKE_LP_PRINTERS || 'prueba_laserjet\netiquetas').trim().split('\n')
  for (const nombre of lista) {
    process.stdout.write(`${nombre} accepting requests since Tue 01 Jan 2024 12:00:00 AM -03\n`)
  }
  process.exit(0)
}

process.stdout.write('request id is fake-1 (1 file(s))\n')
process.exit(0)
