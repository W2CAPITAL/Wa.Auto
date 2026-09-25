@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title WA.Auto - Motor WhatsApp
set "WA_DATA_DIR=%LOCALAPPDATA%\WA.Auto\data"
set "WA_OPEN_BROWSER=1"
set "WA_AUTO_CONNECT=1"
if not exist "%WA_DATA_DIR%" mkdir "%WA_DATA_DIR%" >nul 2>nul

if not exist "%~dp0node.exe" (
  echo ERRO: node.exe nao foi encontrado neste pacote.
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\whatsapp-web.js\package.json" (
  echo ERRO: o pacote esta incompleto. Baixe novamente o WA.Auto-Windows.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:3210/api/bootstrap' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:3210"
  exit /b 0
)

echo Iniciando o motor local em http://127.0.0.1:3210
echo Mantenha esta janela aberta durante os envios.
echo.
"%~dp0node.exe" src\server.js
set "EXITCODE=%ERRORLEVEL%"
echo.
echo O WA.Auto foi encerrado ^(codigo %EXITCODE%^).
pause
exit /b %EXITCODE%
