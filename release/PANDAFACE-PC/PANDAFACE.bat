@echo off
setlocal
cd /d "%~dp0"
title PANDAFACE PC
set NODE_ENV=production
set PANDAFACE_PORTABLE=1
set PANDAFACE_OPEN_BROWSER=1

set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\PANDAFACE\runtime\node.exe" set "NODE_EXE=%LOCALAPPDATA%\PANDAFACE\runtime\node.exe"
if not defined NODE_EXE if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"

if not defined NODE_EXE (
  echo Preparando entorno Node.js portable para PANDAFACE...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$rt = Join-Path $env:LOCALAPPDATA 'PANDAFACE\runtime'; New-Item -ItemType Directory -Force -Path $rt | Out-Null; $zip = Join-Path $env:TEMP 'node-win-x64.zip'; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.21.1/node-v22.21.1-win-x64.zip' -OutFile $zip -UseBasicParsing; $ext = Join-Path $env:TEMP 'node-win-ext'; Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue; Expand-Archive -Path $zip -DestinationPath $ext -Force; $sub = Get-ChildItem $ext -Directory | Select-Object -First 1; Copy-Item (Join-Path $sub.FullName 'node.exe') (Join-Path $rt 'node.exe') -Force"
  if exist "%LOCALAPPDATA%\PANDAFACE\runtime\node.exe" set "NODE_EXE=%LOCALAPPDATA%\PANDAFACE\runtime\node.exe"
)

if not defined NODE_EXE (
  echo [ERROR] No se pudo preparar Node.js automaticamente.
  echo Descarga directamente PANDAFACE.exe desde el boton Instalar PC ^(.exe^).
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" copy /y ".env.example" ".env" >nul
)

echo Iniciando PANDAFACE en http://localhost:3000 ...
"%NODE_EXE%" "%~dp0server.cjs" --open
if errorlevel 1 pause
