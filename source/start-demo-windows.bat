@echo off
setlocal
cd /d "%~dp0"
echo ========================================================
echo SkillFlow v0.3 Dual Fixed-Port Local Demo (18761 / 18762)
echo System A: http://127.0.0.1:18761/sys_a_query.html
echo System B: http://127.0.0.1:18762/sys_b_form.html
echo Press Ctrl+C to stop.
echo ========================================================

py -3 -c "import sys" >nul 2>&1
if %errorlevel%==0 (
    echo [Launcher] Using py -3
    py -3 "%~dp0demo_server.py" %*
    goto :done
)

python -c "import sys" >nul 2>&1
if %errorlevel%==0 (
    echo [Launcher] Using python
    python "%~dp0demo_server.py" %*
    goto :done
)

set "LIBRE_PY=C:\Program Files\LibreOffice\program\python.exe"
if exist "%LIBRE_PY%" (
    "%LIBRE_PY%" -c "import sys" >nul 2>&1
    if %errorlevel%==0 (
        echo [Launcher] Using LibreOffice Python 3
        "%LIBRE_PY%" "%~dp0demo_server.py" %*
        goto :done
    )
)

node --version >nul 2>&1
if %errorlevel%==0 (
    echo [Launcher] Python unavailable, falling back to Node demo_server.mjs
    node "%~dp0demo_server.mjs" %*
    goto :done
)

echo [Error] Neither Python 3 nor Node.js was found on this machine.
echo Please install Python 3 or Node.js and retry.

:done
echo.
echo The dual-port demo server stopped or could not start.
pause
