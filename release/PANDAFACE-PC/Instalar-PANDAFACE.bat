@echo off
setlocal
cd /d "%~dp0"
title Instalador PANDAFACE PC
echo ======================================================
echo   Instalando PANDAFACE en este PC
echo ======================================================
echo.
set "INSTALL_DIR=%LOCALAPPDATA%\PANDAFACE"
echo [1/4] Copiando archivos en "%INSTALL_DIR%" ...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
robocopy "%~dp0." "%INSTALL_DIR%" /E /NFL /NDL /NJH /NJS /NC /NS /XF .env >nul
if not exist "%INSTALL_DIR%\.env" (
  if exist "%INSTALL_DIR%\.env.example" copy /y "%INSTALL_DIR%\.env.example" "%INSTALL_DIR%\.env" >nul
)
echo [2/4] Compilando PANDAFACE.exe nativo ...
set "TARGET_EXE=%INSTALL_DIR%\PANDAFACE.bat"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if exist "%CSC%" (
  pushd "%INSTALL_DIR%"
  "%CSC%" /nologo /target:winexe /out:"PANDAFACE.exe" /r:System.Net.Http.dll "PandafaceLauncher.cs"
  if not errorlevel 1 set "TARGET_EXE=%INSTALL_DIR%\PANDAFACE.exe"
  popd
)
echo [3/4] Creando acceso directo en el Escritorio y Menu Inicio ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut((Join-Path $d 'PANDAFACE.lnk')); $s.TargetPath = '%TARGET_EXE%'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Save(); $sm = Join-Path ([Environment]::GetFolderPath('Programs')) 'PANDAFACE.lnk'; $s2 = $ws.CreateShortcut($sm); $s2.TargetPath = '%TARGET_EXE%'; $s2.WorkingDirectory = '%INSTALL_DIR%'; $s2.Save()"
echo [4/4] Iniciando PANDAFACE ...
start "" "%TARGET_EXE%"
echo.
echo Instalacion completada en: %INSTALL_DIR%
timeout /t 3 /nobreak >nul
