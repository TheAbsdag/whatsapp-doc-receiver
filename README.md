# whatsapp-doc-receiver

Receptor **headless** de documentos de WhatsApp para una máquina **Fedora Linux con poca RAM* (2–4 GB). Un solo proceso Node: Baileys (protocolo WhatsApp Web) + una mini web GUI servida en `http://127.0.0.1:8787`. **Sin Electron, sin navegador, sin bases de datos.**

> ⚠️ Baileys usa el **protocolo no oficial** de WhatsApp Web. Recomendación fuerte: vincula un **número dedicado** (SIM secundaria o línea de solo WhatsApp), nunca tu número personal. Existe riesgo de bloqueo de la cuenta (ver [Riesgos](#riesgos-y-privacidad)).

## Qué hace

1. Se conecta a WhatsApp por QR (la primera vez, o si se desvincula) y queda enlazado en segundo plano.
2. Cuando llega un **documento o imagen**, lo registra en `data/documents.json` (escritura atómica).
3. La web (`http://127.0.0.1:8787`) muestra la tabla: **Fecha y hora · Origen · Remitente · Nombre de archivo · Tamaño · Estado · Acciones**.
4. **Descargar** guarda el archivo en `~/WhatsAppDocs/` (nombre saneado, sin colisiones) y **Imprimir** lo manda a CUPS (`lp`), habilitado solo si ya está descargado. Refresco automático cada 5 segundos.

## Requisitos

| Qué | Detalle |
|---|---|
| OS | Fedora Linux (cualquiera con CUPS) |
| Node.js | **20.0 o superior** (`sudo dnf install nodejs npm`) |
| CUPS | `sudo dnf install cups-client`; impresora configurada: `lpstat -p` |
| Teléfono | Un WhatsApp con un número dedicado (recomendado) |
| Windows (opcional, multiplataforma) | Windows 10/11 con Node 20+; para imprimir: [SumatraPDF](https://www.sumatrapdfreader.org/) portable en el PATH (o `"pdfBin"` en `config.json`) |

RAM: proceso Node + Baileys ≈ ~80–150 MB (frente a cientos de MB–GB de un cliente Electron).

## Instalación de un clic (modo kiosko — recomendado)

Pensado para una máquina **sin teclado** (kiosko): todo se maneja con mouse y un único clic.

**Preparación (una sola vez, la hace quien copia los archivos, con teclado):**

```bash
# 1) Copiar la carpeta a ~/whatsapp-doc-receiver (o la ruta que quieras, sin espacios)
# 2) Datos previos (a menos que el instalador pueda usar sudo sin contraseña):
sudo dnf install nodejs npm cups-client
# 3) Marcar como ejecutables (si la copia desde Windows/USB perdió los permisos):
cd ~/whatsapp-doc-receiver && chmod +x instalar.sh kiosk.sh Instalar.desktop
```

**En la máquina del usuario final (solo mouse):** doble clic en `Instalar.desktop` → si GNOME pregunta, **"Confiar y lanzar"** (una vez, con el mouse). El instalador:

1. Verifica (e instala si hay sudo sin contraseña) `node >= 20` y `cups-client`; si falta algo, muestra el error en una ventana (zenity) — nada de terminal.
2. `npm install` (baileys + pino + qrcode).
3. Genera la unidad del servicio **con la ruta real de node y del proyecto** (`sed` sobre `whatsapp-doc-receiver.service`) y la deja en `~/.config/systemd/user/`, con `systemctl --user enable --now`.
4. Configura el **kiosko** en `~/.config/autostart/`: en el próximo inicio de sesión la web se abre sola a pantalla completa.
5. Espera a que la web responda y la abre para **escanear el QR** con WhatsApp.

El detalle de todo queda en `instalacion.log` (dentro de la carpeta del proyecto). Re-ejecutable: si ya está instalado, solo lo deja arriba y reabre la web.

**Pantalla táctil:** la web está optimizada con `@media (pointer: coarse)` — botones de al menos 48 px, texto y filas mayores en dispositivos táctiles, y el refresco automático se pausa mientras se toca una acción (el toque nunca se pierde).

**Kiosko puro (opcional):** activa autologin en `Ajustes → Usuarios → Login automático` (o `loginctl enable-linger $USER`) y reinicia la máquina: el servicio arranca solo y la web queda a pantalla completa sin tocar nada.

**RAM del kiosko:** el navegador manda. Chrome/Chromium ~300–500 MB; Firefox ~300–400 MB; si quieres menos, `sudo dnf install epiphany` (usa `--application-mode`, ventana limpia, ~150 MB).

## Instalación manual (alternativa)

```bash
# 1) Copiar el proyecto (por ejemplo en ~/)
cd ~
git clone <url-del-repo> whatsapp-doc-receiver   # o copiar la carpeta
cd whatsapp-doc-receiver

# 2) Dependencias (solo baileys, pino, qrcode)
npm install

# 3) Prueba manual (ver más abajo)
npm start
```

La primera vez: abre `http://127.0.0.1:8787`, el estado mostrará **"Desconectado (requiere QR)"**, y en tu teléfono:

> **WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo** → escanea el QR de la página (botón **Escanear QR**).

Tras el enlace, la sesión queda en `data/auth/` y **no** se pedirá QR de nuevo.

## Servicio systemd (usuario)

```bash
mkdir -p ~/.config/systemd/user
cp whatsapp-doc-receiver.service ~/.config/systemd/user/

# IMPORTANTE: si node no está en /usr/bin/node (p. ej. nvm/fnm),
# ajusta ExecStart con la ruta de:  command -v node
# y WorkingDirectory con la carpeta real del proyecto (%h = tu home).

systemctl --user daemon-reload
systemctl --user enable --now whatsapp-doc-receiver
systemctl --user status whatsapp-doc-receiver
```

- Arranca en cada login (`WantedBy=default.target`), tipo `simple`, `Restart=on-failure`, `RestartSec=5`, `After=network-online.target`.
- Logs: `journalctl --user -u whatsapp-doc-receiver -f`
- Reiniciar: `systemctl --user restart whatsapp-doc-receiver`
- (Opcional, arranque sin login) `loginctl enable-linger $USER`

## Windows (multiplataforma)

El mismo proyecto corre en Windows 10/11: el núcleo (Baileys + HTTP + web) es 100 % multiplataforma y está probado; lo único distinto son la impresión y el "servicio".

**Instalación de un clic** (equivalente de `Instalar.desktop`):

```powershell
powershell -ExecutionPolicy Bypass -File .\instalar.ps1        # solo receptor
powershell -ExecutionPolicy Bypass -File .\instalar.ps1 -Kiosk # receptor + Edge a pantalla completa
```

`instalar.ps1` verifica Node 20+, hace `npm install`, crea y arranca la tarea programada **`whatsapp-doc-receiver`** (OnLogon, reinicio ante fallos cada 1 min — equivalente a `Restart=on-failure`), con `-Kiosk` agrega **`whatsapp-doc-kiosk`** (msedge `--kiosk` 30 s después del login) y abre la web para el QR. Detalle en `instalacion-windows.log`. Para desinstalar: `Unregister-ScheduledTask whatsapp-doc-receiver` (y `whatsapp-doc-kiosk`).

**Diferencias con Linux:**

| | Linux (Fedora) | Windows |
|---|---|---|
| Impresora | CUPS (`lp`, `lpstat -a`) | **SumatraPDF** (`-print-to`) — portable, sin instalación; detección vía `Get-Printer` (con fallback por registro si WMI está restringido) |
| Servicio | systemd de usuario | Tareas programadas (OnLogon + restart on failure) |
| Kiosko | GNOME autostart + Chromium/Firefox/Epiphany | Edge `--kiosk` (viene con Windows) |
| Carpeta de descargas | `~/WhatsAppDocs` | `%USERPROFILE%\WhatsAppDocs` (mismo `config.json`) |

Si SumatraPDF no está, la app sigue funcionando (descarga y web OK) y la impresión devuelve un error explicativo en la UI con la solución.

## Publicar releases con GitHub Actions (Linux + Windows)

El repo trae `.github/workflows/release.yml`: al empujar un tag `v*`, cada release genera **dos artefactos** (un `.tgz` por SO) que ejecutan antes `npm test` en runners reales de Ubuntu y Windows.

```bash
# una vez:  gh auth login
# crear el repo y subir:
git init -b main
git add -A && git commit -m "whatsapp-doc-receiver"
gh repo create whatsapp-doc-receiver --public --source=. --push

# cada publicación:
git tag v1.0.0 && git push origin v1.0.0
# → Actions crea la release "v1.0.0" con:
#   whatsapp-doc-receiver-1.0.0-ubuntu-latest.tgz
#   whatsapp-doc-receiver-1.0.0-windows-latest.tgz
```

Los `.tgz` respetan `.gitignore` (`npm pack`): no llevan `node_modules` ni `data`. En Windows se abren con `tar.exe` (incluido en Windows 10+) o 7-Zip; en Linux, `tar xzf`. El flujo completo (tests en ambos SO + empaquetado + release) quedó validado end-to-end: la release `v1.0.0` se generó en GitHub Actions con los artefactos de Ubuntu y Windows.

## Uso diario

Servicio arriba → documento recibido → tabla → **Descargar** → **Imprimir**. También se muestran los documentos **enviados** desde el teléfono vinculado (columna "Origen": Enviado / Recibido), en orden cronológico con el botón para alternar **Nuevos primero / Antiguos primero**.

- **Impresora**: un **dropdown** con las impresoras detectadas por el sistema (`lpstat -a`); la primera opción, "(Por defecto — impresora del sistema)", equivale a `lp` sin `-d`; cualquier otra equivale a `lp -d <nombre>`. Si la detección falla (sin CUPS) se muestra el aviso y se puede guardar igualmente el nombre manualmente si se conoce.
- Los archivos quedan en `~/WhatsAppDocs/` (configurable en `config.json`).
- El estado muestra **Conectado / Reconectando / Desconectado (requiere QR)** y el QR se refresca automáticamente cuando hace falta.

## API (solo loopback)

| Endpoint | Resultado |
|---|---|
| `GET /api/status` | `{ connected, loggedIn, requiresQr, lastMessageAt }` |
| `GET /api/qr` | `{ qrBase64 }` (PNG) o `404` si no hay QR pendiente |
| `GET /api/documents` | lista de registros en orden cronológico (con `status` y `direction`: `sent` / `received`) |
| `POST /api/documents/:id/download` | descarga la media a `~/WhatsAppDocs/` → `{ ok, fileName, path }` |
| `POST /api/documents/:id/print` | ejecuta `lp` → `{ ok, message }` |
| `GET/POST /api/printer` | leer/guardar el nombre de impresora |
| `GET /api/printers` | `{ printers: [...], error? }` — impresoras del sistema (`lpstat -a`) |

Errores en JSON `{ "error": "..." }`: `404` documento inexistente, `409` imprimir sin descargar, `500` fallo de descarga/impresión.

## Configuración (`config.json`)

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "downloadsDir": "~/WhatsAppDocs",
  "printer": ""
}
```

`host` es fijo a loopback por diseño; no lo cambies a `0.0.0.0`. Opcionales (solo tests): `lpBin` y `lpArgsPrefix`.

## Estructura

```
package.json
config.json              # puerto, carpeta de descargas, impresora
whatsapp-doc-receiver.service
Instalar.desktop         # doble clic = instalación (kiosko Linux)
whatsapp-doc-kiosk.desktop  # autostart del kiosko (plantilla)
instalar.sh              # instalador de un clic (Linux)
instalar.ps1             # instalador de un clic (Windows, -Kiosk opcional)
kiosk.sh                 # abre la web a pantalla completa en cada login
.gitattributes           # LF forzado para scripts/servicios (Linux)
.github/workflows/release.yml  # releases Linux + Windows (tag v*)
src/
  index.js               # servidor HTTP plano + API + arranque
  baileys.js             # conexión, QR, reconexión, descarga de media
  store.js               # data/documents.json (JSON atómico)
  printer.js             # lp/lpstat (CUPS) y SumatraPDF/Get-Printer (Windows)
  files.js               # saneado de nombres, colisiones, escritura atómica
  web/                   # index.html, app.js, style.css
test/
  simulate.js            # simulación sin WhatsApp (npm test)
  fake-lp.js             # lp falso para el test
data/                    # sesión auth + documentos.json (gitignored)
```

## Pruebas sin WhatsApp (`npm test`)

El entorno de desarrollo no tiene WhatsApp real, CUPS ni systemd, así que la simulación inyecta documentos de prueba en el store y verifica el flujo completo contra un servidor real en un puerto efímero:

- saneado de nombres (`../../etc/passwd`, rutas de Windows, controles) y colisiones `(1)`, `(2)`;
- la página carga y `GET /api/documents` devuelve los registros;
- **descarga** de media simulada → archivo guardado con nombre final correcto y registro `downloaded`;
- **impresión** con un `lp` simulado (verifica argumentos `-d impresora -- archivo`), y el fallo de CUPS se reporta en `message`;
- errores: `404` id inexistente, `409` imprimir sin descargar; QR PNG base64; persistencia atómica sin `.tmp` residuales.

```bash
npm test    # → "SIMULACIÓN OK — todas las comprobaciones pasaron"
```

En la máquina Fedora, sustituye la impresora simulada por una real: `lpstat -p` y, si no hay ninguna, crea una de pruebas con `lpadmin` (`lpadmin -p test -E -P /usr/share/cups/model/...` o un filtro "Raw").

## Solución de problemas

| Problema | Solución |
|---|---|
| `Instalar.desktop` se abre como texto | Falta el bit ejecutable (pasa al copiar desde Windows/USB). Con mouse: botón derecho → Propiedades → Permisos → "Permitir ejecutar el archivo como programa", o una vez con teclado: `chmod +x Instalar.desktop instalar.sh kiosk.sh` |
| El kiosko no aparece al iniciar | `systemctl --user enable --now whatsapp-doc-receiver` debe estar activo; revisa `~/.config/autostart/whatsapp-doc-kiosk.desktop` (debe apuntar a la ruta real de `kiosk.sh`) y que haya sesión gráfica (autologin activado) |
| Desactivar el kiosko temporalmente | Desde SSH: `pkill -f kiosk.sh`; para quitarlo del autostart: `rm ~/.config/autostart/whatsapp-doc-kiosk.desktop` |
| "Reconectando" sin QR | Espera: reconexión automática con backoff (2s→30s). Si persiste: `journalctl --user -u whatsapp-doc-receiver -f` |
| Sesión desvinculada / otro teléfono | La app lo detecta (`DisconnectReason.loggedOut`), limpia `data/auth/` y muestra un QR fresco en la web. Si no aparece: `systemctl --user restart whatsapp-doc-receiver` |
| No llegan mensajes | La app **solo** ve mensajes nuevos tras el enlace (no lee el historial). Verifica que el ítem sea un documento/imagen (no un sticker/enlace) y que el registro esté en `data/documents.json` |
| Descarga falla: media expirada | WhatsApp expira la media; la descarga solo funciona mientras la clave del mensaje siga vigente. El error se muestra en la UI |
| "Impresora no encontrada" | `lpstat -p` / `lpadmin -p NOMBRE -E`; prueba `lp -d NOMBRE ~/WhatsAppDocs/archivo.pdf`. Revisa que `cups-client` esté instalado: `dnf list installed cups-client` |
| `lp` imprime en otra impresora | Configura el nombre en el campo de la web (o `config.json → printer`) y guarda; deja vacío para la por defecto |
| No arranca el servicio | `systemctl --user status`, revisa `ExecStart` (ruta real de node: `command -v node`) y `WorkingDirectory` |
| Puerto 8787 ocupado | Cambia `port` en `config.json` |

## Riesgos y privacidad

- **Baneo**: el protocolo de WhatsApp Web es no oficial y usar Baileys viola los términos de WhatsApp; hay riesgo de bloqueo de la cuenta. Usa un **número dedicado**. La aplicación **no** intenta evadir detecciones ni trucos "anti-ban".
- **Seguridad local**: el servidor escucha solo en `127.0.0.1`; no lo expongas. Los nombres de archivo se sanean y `lp` se invoca con `spawn/binario + argumentos` (nunca una cadena shell), por lo que un nombre malicioso no puede inyectar comandos.
- La sesión y los registros contienen datos de tus contactos; `data/` está en `.gitignore`.
