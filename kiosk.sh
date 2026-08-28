#!/usr/bin/env bash
# ============================================================================
# Kiosko: abre la web del receptor de documentos a pantalla completa.
# Se lanza desde ~/.config/autostart/whatsapp-doc-kiosk.desktop en cada login.
# Si se cierra el navegador, se reabre a los 5 s (kiosko sin teclado).
# ============================================================================
set -u

URL="${WDR_KIOSK_URL:-http://127.0.0.1:8787}"

# --- esperar el servicio (arranque lento en máquinas con poca RAM) ----------
for _ in $(seq 1 60); do
  systemctl --user is-active --quiet whatsapp-doc-receiver 2>/dev/null && break
  sleep 1
done

# --- elegir navegador (el primero que exista) --------------------------------
BROWSER=""
for b in chromium chromium-browser google-chrome google-chrome-stable firefox epiphany; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done

if [ -z "$BROWSER" ]; then
  # nada disponible: probar de nuevo dentro de un minuto
  sleep 60
  exec "$0" "$@"
fi

log() { echo "[$(date '+%H:%M:%S')] $*" >>"${WDR_KIOSK_LOG:-/tmp/whatsapp-doc-kiosk.log}"; }
log "kiosko: abriendo $URL con $BROWSER"

case "$BROWSER" in
  *chromium*|*chrome*)
    # --password-store=basic: evita el diálogo del llavero (no hay teclado)
    set -- --kiosk --no-first-run --no-default-browser-check \
      --disable-session-crashed-bubble --password-store=basic "$URL"
    ;;
  *firefox*)
    set -- --kiosk "$URL"
    ;;
  *epiphany*)
    set -- --application-mode "$URL"
    ;;
  *)
    set -- "$URL"
    ;;
esac

while true; do
  "$BROWSER" "$@"
  log "kiosko: navegador cerrado; reabriendo en 5 s"
  sleep 5
done
