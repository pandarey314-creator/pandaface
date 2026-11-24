@echo off
setlocal
cd /d "%~dp0"
title Generador PANDAFACE.exe
echo ======================================================
echo   Generador de PANDAFACE.exe para Windows
echo ======================================================
echo.
echo [1/2] Compilando PANDAFACE.exe nativo con .NET Framework...
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if exist "%CSC%" (
  "%CSC%" /nologo /target:winexe /out:"PANDAFACE.exe" /r:System.Net.Http.dll "PandafaceLauncher.cs"
  if not errorlevel 1 (
    echo [OK] PANDAFACE.exe generado correctamente en:
    echo      %~dp0PANDAFACE.exe
  ) else (
    echo [ERROR] Fallo compilando con csc.exe
  )
) else (
  echo [AVISO] No se encontro csc.exe en este equipo.
)
echo.
echo [2/2] Opcional: generar ejecutable 100%% autonomo sin Node.js (PANDAFACE-Standalone.exe)
where npx >nul 2>&1
if not errorlevel 1 (
  choice /M "Deseas empaquetar tambien PANDAFACE-Standalone.exe (~70MB, no requiere Node.js)?"
  if errorlevel 2 goto done
  npx --yes @yao-pkg/pkg server.cjs --targets node20-win-x64 --output PANDAFACE-Standalone.exe
)
:done
echo.
echo Listo. Ejecuta PANDAFACE.exe para abrir la aplicacion.
pause
