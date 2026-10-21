@echo off
setlocal
cd /d "%~dp0"
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 (
  py -3 RUN_CONSOLE.py
  exit /b
)
python -c "import sys" >nul 2>&1
if not errorlevel 1 (
  python RUN_CONSOLE.py
  exit /b
)
powershell -NoProfile -Command "$p = Join-Path (Get-Location).Path 'Qwen_Map_Console.html'; $u = ([System.Uri]$p).AbsoluteUri; Start-Process $u"
if errorlevel 1 (
  start "" "%~dp0Qwen_Map_Console.html"
)
endlocal
