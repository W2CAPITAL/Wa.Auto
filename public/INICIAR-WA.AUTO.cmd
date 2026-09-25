@echo off
setlocal EnableExtensions
title WA.Auto - Instalador e Inicializador

set "APP_DIR=%LOCALAPPDATA%\WA.Auto\app"
set "TMP_DIR=%TEMP%\wa-auto-setup"
set "ZIP_FILE=%TEMP%\wa-auto-main.zip"

echo.
echo ==========================================
echo          WA.Auto para Windows
echo ==========================================
echo.
echo Preparando a versao mais recente...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';" ^
  "$zip='%ZIP_FILE%'; $tmp='%TMP_DIR%'; $dest='%APP_DIR%';" ^
  "if(Test-Path $zip){Remove-Item $zip -Force}; if(Test-Path $tmp){Remove-Item $tmp -Recurse -Force};" ^
  "Invoke-WebRequest 'https://github.com/W2CAPITAL/Wa.Auto/archive/refs/heads/main.zip' -OutFile $zip -UseBasicParsing;" ^
  "Expand-Archive $zip -DestinationPath $tmp -Force;" ^
  "$src=Get-ChildItem $tmp -Directory | Where-Object {$_.Name -like 'Wa.Auto-*'} | Select-Object -First 1;" ^
  "if(-not $src){throw 'Pacote do WA.Auto invalido'};" ^
  "if(Test-Path $dest){Remove-Item $dest -Recurse -Force}; New-Item $dest -ItemType Directory -Force | Out-Null;" ^
  "Copy-Item ($src.FullName+'\*') $dest -Recurse -Force;"

if errorlevel 1 (
  echo.
  echo ERRO: nao foi possivel baixar ou preparar o WA.Auto.
  echo Confira sua internet e tente novamente.
  pause
  exit /b 1
)

echo.
echo WA.Auto atualizado.
echo Abrindo o motor local...
echo.

call "%APP_DIR%\INICIAR-WINDOWS.cmd"
exit /b %ERRORLEVEL%
