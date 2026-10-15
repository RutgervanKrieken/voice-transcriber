@echo off
rem Starts the Voice Transcriber: finds or fetches Python, then serves this
rem folder on localhost and opens it in the default browser.
setlocal

cd /d "%~dp0"
set PORT=8080

where python >nul 2>nul
if %errorlevel%==0 (
    set "PYCMD=python"
    goto :run
)

where py >nul 2>nul
if %errorlevel%==0 (
    set "PYCMD=py"
    goto :run
)

rem No system Python found: fetch a portable copy into .python-embed (no install, no admin rights).
set "PY_DIR=%~dp0.python-embed"
set "PYCMD=%PY_DIR%\python.exe"

if exist "%PYCMD%" goto :run

echo Python not found on this machine. Downloading a portable copy (~11 MB)...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-embed-amd64.zip' -OutFile '%~dp0python-embed.zip'"
if errorlevel 1 (
    echo.
    echo Download failed. Please install Python from https://www.python.org/downloads/
    echo and run this script again, or ask for help.
    pause
    exit /b 1
)

powershell -NoProfile -Command "Expand-Archive -Path '%~dp0python-embed.zip' -DestinationPath '%PY_DIR%' -Force"
del "%~dp0python-embed.zip"

rem The embeddable zip ships with site-packages/imports disabled by default;
rem serve.py only needs the standard library, so no change is required.

:run
echo Starting the Voice Transcriber server on http://localhost:%PORT% ...
start "Voice Transcriber Server" "%PYCMD%" serve.py %PORT%

rem Give the server a moment to come up before opening the page.
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"

echo.
echo The server is running in the other window titled "Voice Transcriber Server".
echo Close that window to stop it. You can re-run this script any time.
