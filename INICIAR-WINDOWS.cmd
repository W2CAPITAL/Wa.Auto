@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title WA.Auto - Inicializador

set "WA_DATA_DIR=%LOCALAPPDATA%\WA.Auto\data"
set "WA_LOG_DIR=%LOCALAPPDATA%\WA.Auto\logs"
set "WA_OPEN_BROWSER=0"
set "WA_AUTO_CONNECT=1"
set "RUNTIME=%~dp0.runtime\node"
set "TMPNODE=%~dp0.runtime\download"
set "NODE_EXE="
set "NPM_EXE="

if not exist "%WA_DATA_DIR%" mkdir "%WA_DATA_DIR%" >nul 2>nul
if not exist "%WA_LOG_DIR%" mkdir "%WA_LOG_DIR%" >nul 2>nul
if not exist "%~dp0.runtime" mkdir "%~dp0.runtime" >nul 2>nul

for /f "tokens=1-4 delims=/ " %%a in ("%date%") do set "D=%%a-%%b-%%c-%%d"
for /f "tokens=1-3 delims=:,." %%a in ("%time%") do set "T=%%a-%%b-%%c"
set "T=%T: =0%"
set "LOG=%WA_LOG_DIR%\startup-%D%-%T%.log"

echo WA.Auto startup > "%LOG%"
echo Pasta: %CD% >> "%LOG%"

echo.
echo [1/5] Procurando Node.js compativel...

if exist "%RUNTIME%\node.exe" (
  for /f "delims=" %%V in ('"%RUNTIME%\node.exe" -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "RUNTIME_MAJOR=%%V"
  if defined RUNTIME_MAJOR if !RUNTIME_MAJOR! GEQ 20 (
    set "NODE_EXE=%RUNTIME%\node.exe"
    set "NPM_EXE=%RUNTIME%\npm.cmd"
  )
)

if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "SYSTEM_MAJOR=%%V"
    if defined SYSTEM_MAJOR if !SYSTEM_MAJOR! GEQ 20 (
      for /f "delims=" %%P in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%P"
      for /f "delims=" %%P in ('where npm.cmd 2^>nul') do if not defined NPM_EXE set "NPM_EXE=%%P"
    )
  )
)

if not defined NODE_EXE (
  echo Node.js 20+ nao encontrado. Preparando runtime portatil...
  echo Baixando Node.js oficial... >> "%LOG%"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$root='%TMPNODE%'; if(Test-Path $root){Remove-Item $root -Recurse -Force}; New-Item $root -ItemType Directory -Force | Out-Null;" ^
    "$base='https://nodejs.org/dist/latest-v22.x/';" ^
    "$s=(Invoke-WebRequest ($base+'SHASUMS256.txt') -UseBasicParsing).Content;" ^
    "$m=[regex]::Match($s,'node-v22\.[0-9]+\.[0-9]+-win-x64\.zip'); if(-not $m.Success){throw 'Node 22 para Windows nao encontrado'};" ^
    "$name=$m.Value; Invoke-WebRequest ($base+$name) -OutFile ($root+'\node.zip') -UseBasicParsing;" ^
    "Expand-Archive ($root+'\node.zip') -DestinationPath $root -Force;" ^
    "$src=Get-ChildItem $root -Directory | Where-Object {$_.Name -like 'node-v22*-win-x64'} | Select-Object -First 1;" ^
    "if(-not $src){throw 'Pacote do Node invalido'};" ^
    "New-Item '%RUNTIME%' -ItemType Directory -Force | Out-Null; Copy-Item ($src.FullName+'\*') '%RUNTIME%' -Recurse -Force;" >> "%LOG%" 2>&1
  if errorlevel 1 goto :fatal_node
  set "NODE_EXE=%RUNTIME%\node.exe"
  set "NPM_EXE=%RUNTIME%\npm.cmd"
)

if not exist "%NODE_EXE%" goto :fatal_node
if not defined NPM_EXE goto :fatal_node
echo Node: %NODE_EXE%
"%NODE_EXE%" --version
"%NODE_EXE%" --version >> "%LOG%" 2>&1

echo.
echo [2/5] Verificando dependencias...
"%NODE_EXE%" scripts\install-check.js >> "%LOG%" 2>&1
if errorlevel 1 (
  echo Instalando dependencias. Na primeira vez pode levar alguns minutos...
  call "%NPM_EXE%" ci --no-fund >> "%LOG%" 2>&1
  if errorlevel 1 goto :fatal_npm
  "%NODE_EXE%" scripts\install-check.js --save >> "%LOG%" 2>&1
  if errorlevel 1 goto :fatal_npm
)
echo Dependencias OK.

echo.
echo [3/5] Limpando lock antigo, se houver...
if exist "%WA_DATA_DIR%\app.lock" (
  set "LOCKPID="
  set /p LOCKPID=<"%WA_DATA_DIR%\app.lock"
  if defined LOCKPID (
    tasklist /FI "PID eq !LOCKPID!" 2>nul | findstr /R /C:" !LOCKPID! " >nul
    if errorlevel 1 del /q "%WA_DATA_DIR%\app.lock" >nul 2>nul
  ) else (
    del /q "%WA_DATA_DIR%\app.lock" >nul 2>nul
  )
)

echo.
echo [4/5] Iniciando motor local...
powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:3210/api/health' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo Motor ja estava ativo.
  goto :open_app
)

start "WA.Auto Motor" /B cmd /c ""%NODE_EXE%" src\server.js 1>>"%LOG%" 2>>&1"

set /a WAIT=0
:wait_health
set /a WAIT+=1
powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:3210/api/health' -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto :open_app
if !WAIT! GEQ 30 goto :fatal_start
timeout /t 1 /nobreak >nul
goto :wait_health

:open_app
echo.
echo [5/5] WA.Auto pronto.
echo Abrindo http://127.0.0.1:3210
start "" "http://127.0.0.1:3210"
echo.
echo Motor ativo. Nao feche esta janela durante os envios.
echo Log: %LOG%
echo.
echo Pressione qualquer tecla para encerrar o WA.Auto.
pause >nul
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"127.0.0.1:3210 .*LISTENING"') do taskkill /PID %%P /T /F >nul 2>nul
exit /b 0

:fatal_node
echo.
echo ERRO: nao foi possivel localizar ou preparar Node.js 20+.
echo Veja o log: %LOG%
pause
exit /b 1

:fatal_npm
echo.
echo ERRO: nao foi possivel instalar/verificar as dependencias.
echo Veja o log: %LOG%
pause
exit /b 1

:fatal_start
echo.
echo ERRO: o motor nao abriu a porta 3210 em ate 30 segundos.
echo.
echo Ultimas linhas do log:
powershell -NoProfile -Command "if(Test-Path '%LOG%'){Get-Content '%LOG%' -Tail 30}"
echo.
echo Log completo: %LOG%
pause
exit /b 1
