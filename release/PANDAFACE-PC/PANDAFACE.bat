@echo off
setlocal
cd /d "%~dp0"
title PANDAFACE PC
set NODE_ENV=production
set PANDAFACE_PORTABLE=1
set PANDAFACE_OPEN_BROWSER=1

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js en este PC.
  echo Instala Node.js LTS desde https://nodejs.org o ejecuta Crear-PANDAFACE-EXE.bat
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" copy /y ".env.example" ".env" >nul
)

echo Iniciando PANDAFACE en http://localhost:3000 ...
node "%~dp0server.cjs" --open
if errorlevel 1 pause
