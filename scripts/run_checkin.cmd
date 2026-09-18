@echo off
setlocal
:: TraeWork daily check-in
set "TRAE_EXE=D:\2026.7.14后安装软件\TRAE SOLO CN\TRAE SOLO CN.exe"
if not exist "%TRAE_EXE%" (
  echo ERROR: TRAE SOLO CN.exe not found at: %TRAE_EXE%
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
set VSCODE_DEV=
"%TRAE_EXE%" "%~dp0checkin.js"
endlocal
