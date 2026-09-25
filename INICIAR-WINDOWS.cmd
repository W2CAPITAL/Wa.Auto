@echo off
setlocal
cd /d "%~dp0"
title WA.Auto - WhatsApp para clientes
where node >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 24 LTS em https://nodejs.org/en/download
  echo Depois feche esta janela e abra INICIAR-WINDOWS.cmd novamente.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])===24?0:1)"
if errorlevel 1 (
  echo Esta versao do WA.Auto usa Node.js 24 LTS.
  echo Instale a versao 24 em https://nodejs.org/en/download
  pause
  exit /b 1
)
node scripts/install-check.js
if errorlevel 1 (
  echo Preparando o WA.Auto. Na primeira vez, o navegador tambem sera baixado.
  call npm ci --no-fund
  if errorlevel 1 (
    echo A instalacao falhou. Confira sua internet e tente novamente.
    pause
    exit /b 1
  )
  node scripts/install-check.js --save
)
set "WA_OPEN_BROWSER=1"
call npm start
pause
