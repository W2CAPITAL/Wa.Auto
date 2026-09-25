@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title WA.Auto - Inicializador

set "RUNTIME=%~dp0.runtime\node"
set "NODE=%RUNTIME%\node.exe"
set "NPM=%RUNTIME%\npm.cmd"
set "TMPNODE=%~dp0.runtime\download"
set "WA_DATA_DIR=%LOCALAPPDATA%\WA.Auto\data"
set "WA_OPEN_BROWSER=1"
set "WA_AUTO_CONNECT=1"

if not exist "%WA_DATA_DIR%" mkdir "%WA_DATA_DIR%" >nul 2>nul
if not exist "%~dp0.runtime" mkdir "%~dp0.runtime" >nul 2>nul

if not exist "%NODE%" (
  echo.
  echo [1/4] Preparando o motor do WA.Auto...
  where node >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
    if "%NODE_MAJOR%"=="24" (
      for /f "delims=" %%P in ('where node') do (
        set "NODE=%%P"
        goto :node_ready
      )
    )
  )

  echo Node 24 nao encontrado. Baixando uma copia portatil oficial...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$root='%TMPNODE%'; if(Test-Path $root){Remove-Item $root -Recurse -Force}; New-Item $root -ItemType Directory ^| Out-Null;" ^
    "$base='https://nodejs.org/dist/latest-v24.x/';" ^
    "$s=(Invoke-WebRequest ($base+'SHASUMS256.txt') -UseBasicParsing).Content;" ^
    "$m=[regex]::Match($s,'node-v24\.[0-9]+\.[0-9]+-win-x64\.zip'); if(-not $m.Success){throw 'Node 24 para Windows nao encontrado'};" ^
    "$name=$m.Value; Invoke-WebRequest ($base+$name) -OutFile ($root+'\node.zip') -UseBasicParsing;" ^
    "Expand-Archive ($root+'\node.zip') -DestinationPath $root -Force;" ^
    "$src=Get-ChildItem $root -Directory ^| Where-Object {$_.Name -like 'node-v24*-win-x64'} ^| Select-Object -First 1;" ^
    "if(-not $src){throw 'Pacote do Node invalido'};" ^
    "New-Item '%RUNTIME%' -ItemType Directory -Force ^| Out-Null; Copy-Item ($src.FullName+'\*') '%RUNTIME%' -Recurse -Force;"
  if errorlevel 1 (
    echo.
    echo ERRO: nao foi possivel preparar o Node automaticamente.
    echo Confira a internet e execute este arquivo novamente.
    pause
    exit /b 1
  )
)

:node_ready
if exist "%RUNTIME%\node.exe" (
  set "NODE=%RUNTIME%\node.exe"
  set "NPM=%RUNTIME%\npm.cmd"
  set "PATH=%RUNTIME%;%PATH%"
) else (
  set "NPM=npm.cmd"
)

echo.
echo [2/4] Verificando dependencias...
"%NODE%" scripts\install-check.js >nul 2>nul
if errorlevel 1 (
  echo Instalando dependencias. Na primeira vez isso pode levar alguns minutos...
  call "%NPM%" ci --no-fund
  if errorlevel 1 (
    echo.
    echo ERRO: a instalacao das dependencias falhou.
    echo Feche antivirus/proxy que esteja bloqueando npm, confira a internet e tente novamente.
    pause
    exit /b 1
  )
  "%NODE%" scripts\install-check.js --save
)

echo.
echo [3/4] Verificando a porta local...
powershell -NoProfile -Command "try { $r=Invoke-WebRequest 'http://127.0.0.1:3210/api/bootstrap' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo WA.Auto ja esta rodando.
  start "" "http://127.0.0.1:3210"
  exit /b 0
)

echo.
echo [4/4] Iniciando WA.Auto...
echo Mantenha esta janela aberta enquanto estiver usando o WhatsApp.
echo Se ocorrer erro, ele aparecera aqui.
echo.
"%NODE%" src\server.js
set "EXITCODE=%ERRORLEVEL%"
echo.
echo O motor do WA.Auto foi encerrado ^(codigo %EXITCODE%^).
if not "%EXITCODE%"=="0" (
  echo Copie a mensagem de erro acima se precisar de suporte.
)
pause
exit /b %EXITCODE%
