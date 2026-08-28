#!/usr/bin/env bash
# ============================================================================
# Abre la web del receptor de documentos UNA sola vez en el NAVEGADOR
# PREDETERMINADO del sistema (xdg-open), sin pantalla completa.
# Se lanza desde ~/.config/autostart/whatsapp-doc-kiosk.desktop en cada login.
# Si se cierra, se reabre a mano con el acceso directo del escritorio; aquí no
# se vigila ni se fuerza la reapertura.
# ============================================================================
set -u

URL="${WDR_URL:-http://127.0.0.1:8787}"

log() { echo "[$(date '+%H:%M:%S')] $*" >>"${WDR_KIOSK_LOG:-/tmp/whatsapp-doc-kiosk.log}"; }

# --- esperar el servicio (arranque lento en máquinas con poca RAM) ----------
for _ in $(seq 1 60); do
  systemctl --user is-active --quiet whatsapp-doc-receiver 2>/dev/null && break
  sleep 1
done

# --- esperar a que el servidor HTTP responda (hasta 30 s más) ---------------
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1 && curl -s -o /dev/null --max-time 2 "$URL/api/status"; then break; fi
  if command -v wget >/dev/null 2>&1 && wget -q -O /dev/null --timeout=2 "$URL/api/status"; then break; fi
  sleep 1
done

log "abriendo $URL una vez en el navegador predeterminado"
xdg-open "$URL" >/dev/null 2>&1 || true
