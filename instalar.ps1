<#
  Instalador de UN CLIC para Windows (sin CUPS ni systemd).
  Equivalente de instalar.sh:
    - verifica Node 20+ y hace npm install
    - registra la tarea "whatsapp-doc-receiver" (arranca en cada inicio de sesión,
      con reinicio automático ante fallos ~ Restart=on-failure de systemd)
    - registra "whatsapp-doc-web": abre el NAVEGADOR PREDETERMINADO con la web
      UNA sola vez al iniciar sesión (sin pantalla completa) y crea un acceso
      directo en el escritorio para reabrirla a mano si se cierra
      (desregistra el antiguo kiosko de pantalla completa, si existía)
    - espera la web y la abre para escanear el QR
  Uso (una vez):  powershell -ExecutionPolicy Bypass -File .\instalar.ps1
  Detalle: instalacion-windows.log en la carpeta del proyecto.
#>
$ErrorActionPreference = 'Stop'

$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOG = Join-Path $DIR 'instalacion-windows.log'
function Log($m) { "$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')) $m" | Tee-Object -FilePath $LOG -Append | Write-Host }

Log "=== Instalación de whatsapp-doc-receiver (carpeta: $DIR) ==="
Set-Location $DIR

# ---------------------------------------------------------------- 1) Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw 'Node.js 20+ no está instalado. Descargá el instalador desde https://nodejs.org y volvé a ejecutar este script.'
}
$ver = & node --version
$mayor = [int](($ver -replace '^v', '') -split '\.')[0]
if ($mayor -lt 20) { throw "Node $ver es demasiado viejo (se necesita 20+)." }
Log "Node $ver OK"

# ---------------------------------------------------------------- 2) deps
Log 'npm install… (puede tardar la primera vez)'
& npm.cmd install --no-audit --no-fund *>> $LOG
if ($LASTEXITCODE -ne 0) { throw "Falló 'npm install'. Revisá $LOG" }
Log 'Dependencias OK'

# ------------------------------------------- 3) tarea del servicio (on-logon
$accion = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "`"$DIR\src\index.js`"" -WorkingDirectory $DIR
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'whatsapp-doc-receiver' -Action $accion -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'whatsapp-doc-receiver'
Log 'Tarea "whatsapp-doc-receiver" registrada y arrancada (se inicia sola en cada inicio de sesión)'

# --------------------------- 4) web en el navegador predeterminado (1 vez al
# Migración: elimina el antiguo kiosko de pantalla completa si existía.
Unregister-ScheduledTask -TaskName 'whatsapp-doc-kiosk' -Confirm:$false -ErrorAction SilentlyContinue

# Abre el navegador predeterminado (cmd /c start) 30 s después del login,
# cuando el servicio ya debería estar escuchando.
$webAccion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c start "" http://127.0.0.1:8787'
$webTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME -Delay (New-TimeSpan -Seconds 30)
Register-ScheduledTask -TaskName 'whatsapp-doc-web' -Action $webAccion -Trigger $webTrigger -Force | Out-Null
Log 'Tarea "whatsapp-doc-web" registrada: el navegador predeterminado se abrirá UNA vez en cada inicio de sesión (sin pantalla completa)'

# Acceso directo en el escritorio: reabrir a mano si se cierra.
try {
  $ws = New-Object -ComObject WScript.Shell
  $acceso = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Receptor de documentos.lnk'))
  $acceso.TargetPath = 'http://127.0.0.1:8787'
  $acceso.Description = 'Abre el receptor de documentos de WhatsApp'
  $acceso.Save()
  Log 'Acceso directo "Receptor de documentos" creado en el escritorio (para reabrir la web si se cierra)'
} catch {
  Log "No se pudo crear el acceso directo del escritorio: $($_.Exception.Message)"
}

# ---------------------------------------------------------------- 5) la web
Log 'Esperando la web…'
for ($i = 0; $i -lt 30; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8787/api/status' | Out-Null; break }
  catch { Start-Sleep -Seconds 1 }
}
Start-Process 'http://127.0.0.1:8787'
Log 'Listo: escaneá el QR con WhatsApp (Dispositivos vinculados). Todo el detalle en instalacion-windows.log'
Start-Sleep -Seconds 3
