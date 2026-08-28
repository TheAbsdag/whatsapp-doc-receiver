#!/usr/bin/env bash
# ============================================================================
# Instalador de UN SOLO CLIC para whatsapp-doc-receiver (Fedora, GNOME).
#
# Qué hace (sin pedir nada al usuario):
#   1. Verifica/instala Node.js 20+ y cups-client (si hay sudo sin contraseña).
#   2. npm install (baileys + pino + qrcode).
#   3. Genera e instala el servicio systemd de USUARIO y lo arranca.
#   4. Configura el kiosko (navegador a pantalla completa) para el próximo login.
#   5. Espera la web y la abre para escanear el QR de WhatsApp.
#
# Sin teclado: los mensajes van por ventanas zenity (mouse) y todo el detalle
# queda en instalar.log dentro de la carpeta del proyecto.
# Re-ejecutable: si ya está instalado, lo deja arriba y vuelve a intentar.
# ============================================================================
set -u

SCRIPT="${BASH_SOURCE[0]}"
cd "$(dirname "$SCRIPT")" || exit 1
DIR=$(pwd)
LOG="$DIR/instalacion.log"
URL="http://127.0.0.1:8787"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

aviso() { # $1 = info|error, $2 = texto (puede contener \n)
  log "$1: $2"
  if command -v zenity >/dev/null 2>&1; then
    if [ "$1" = "error" ]; then
      zenity --error --title="whatsapp-doc-receiver" --text="$2" --timeout=30 >/dev/null 2>&1 || true
    else
      zenity --info --title="whatsapp-doc-receiver" --text="$2" --timeout=30 >/dev/null 2>&1 || true
    fi
  fi
}

log "=== Instalación de whatsapp-doc-receiver (carpeta: $DIR) ==="
cd "$DIR" || { aviso error "No se pudo entrar en $DIR"; exit 1; }

# ---------------------------------------------------------------------------
# 1) Node.js >= 20
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "Node no está instalado; intento instalarlo con sudo no interactivo…"
  if ! sudo -n dnf install -y nodejs npm >/dev/null 2>&1; then
    aviso error "Falta Node.js 20+ y no hay sudo sin contraseña.\n\nPrepará la máquina una vez (con teclado):\nsudo dnf install nodejs npm cups-client\n\nDespués volvé a ejecutar este instalador."
    exit 1
  fi
fi
NODE_MAYOR=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ "${NODE_MAYOR:-0}" -lt 20 ]; then
  aviso error "Node $(node -v) es demasiado viejo. Se necesita Node 20+.\nsudo dnf install nodejs npm"
  exit 1
fi
log "Node $(node -v) OK"

# ---------------------------------------------------------------------------
# 2) CUPS (solo aviso: el receptor funciona sin impresora)
# ---------------------------------------------------------------------------
if ! command -v lp >/dev/null 2>&1; then
  log "lp (CUPS) no está; intento instalar cups-client…"
  sudo -n dnf install -y cups-client >/dev/null 2>&1 \
    && log "cups-client instalado" \
    || aviso error "No se pudo instalar cups-client.\nLa recepción y la web funcionan, pero imprimir no.\n(Una vez, con teclado: sudo dnf install cups-client)"
fi

# ---------------------------------------------------------------------------
# 3) Dependencias
# ---------------------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  aviso error "npm no está disponible (en Fedora el paquete es 'nodejs npm').\nsudo dnf install nodejs npm"
  exit 1
fi
log "npm install… (puede tardar un poco la primera vez)"
if ! npm install --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1; then
  aviso error "Falló 'npm install'. Revisá $LOG"
  exit 1
fi
log "Dependencias OK"

# ---------------------------------------------------------------------------
# 4) Servicio systemd de usuario (con node real y ruta real del proyecto)
# ---------------------------------------------------------------------------
NODE_BIN=$(command -v node)
mkdir -p "$HOME/.config/systemd/user"
sed -e "s|^ExecStart=.*|ExecStart=$NODE_BIN src/index.js|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$DIR|" \
    "$DIR/whatsapp-doc-receiver.service" \
    > "$HOME/.config/systemd/user/whatsapp-doc-receiver.service"
log "Unidad del servicio: $NODE_BIN · $DIR"

systemctl --user daemon-reload >/dev/null 2>&1
systemctl --user enable --now whatsapp-doc-receiver >>"$LOG" 2>&1 || true

# esperar a que el servicio quede activo (hasta 15 s)
estado="inactivo"
for _ in $(seq 1 15); do
  estado=$(systemctl --user is-active whatsapp-doc-receiver 2>/dev/null || echo inactivo)
  [ "$estado" = "active" ] && break
  sleep 1
done
if [ "$estado" != "active" ]; then
  aviso error "El servicio no quedó activo (estado: $estado).\nRevisá: journalctl --user -u whatsapp-doc-receiver -n 50\n(queda registrado en $LOG)"
  exit 1
fi
log "Servicio activo (arrancará solo en cada inicio de sesión)"

# ---------------------------------------------------------------------------
# 5) Kiosko: navegador a pantalla completa en el próximo inicio de sesión
# ---------------------------------------------------------------------------
chmod +x "$DIR/kiosk.sh" "$DIR/Instalar.desktop" 2>/dev/null || true
mkdir -p "$HOME/.config/autostart"
sed "s|^Exec=.*|Exec=$DIR/kiosk.sh|" "$DIR/whatsapp-doc-kiosk.desktop" \
  > "$HOME/.config/autostart/whatsapp-doc-kiosk.desktop"
log "Kiosko configurado en ~/.config/autostart (se abre solo en el próximo login)"

# ---------------------------------------------------------------------------
# 6) Esperar la web y abrirla para escanear el QR
# ---------------------------------------------------------------------------
log "Esperando la web en $URL…"
for _ in $(seq 1 30); do
  node -e "fetch('$URL/api/status').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1 && break
  sleep 1
done
xdg-open "$URL" >/dev/null 2>&1 || true

aviso info "Instalación lista ✅\n\n$URL se abrió en el navegador:\nescaneá el QR con WhatsApp (Dispositivos vinculados).\n\nEn el PRÓXIMO inicio de sesión la web se abrirá sola a pantalla completa (kiosko)."
log "=== Listo ==="
