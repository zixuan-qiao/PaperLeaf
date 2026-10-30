@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: 1. Search for a Python environment that has Flask installed
set "PY_EXE="
set "PY_FALLBACK="

:: 1. Priority 0: Check cached .python_path for zero-overhead instant launch
if exist "%~dp0.python_path" (
    set /p CACHED_PY=<"%~dp0.python_path"
    if exist "!CACHED_PY!" (
        "!CACHED_PY!" -c "import flask" >nul 2>nul
        if !errorlevel! equ 0 (
            set "PY_EXE=!CACHED_PY!"
            goto :LAUNCH
        )
    )
)

:: 2. Priority 1: Check local project virtual environment (venv)
if exist "%~dp0venv\Scripts\python.exe" (
    "%~dp0venv\Scripts\python.exe" -c "import flask" >nul 2>nul
    if !errorlevel! equ 0 (
        if exist "%~dp0venv\Scripts\pythonw.exe" (
            set "PY_EXE=%~dp0venv\Scripts\pythonw.exe"
        ) else (
            set "PY_EXE=%~dp0venv\Scripts\python.exe"
        )
        echo !PY_EXE!>"%~dp0.python_path"
        goto :LAUNCH
    )
)

:: 3. Priority 2: Scan Python executables in system PATH
for /f "tokens=*" %%i in ('where python 2^>nul') do (
    if "!PY_FALLBACK!"=="" set "PY_FALLBACK=%%i"
    "%%i" -c "import flask" >nul 2>nul
    if !errorlevel! equ 0 (
        if exist "%%~dpi\pythonw.exe" (
            set "PY_EXE=%%~dpi\pythonw.exe"
        ) else (
            set "PY_EXE=%%i"
        )
        echo !PY_EXE!>"%~dp0.python_path"
        goto :LAUNCH
    )
)

:: 4. Priority 3: Scan common Python and Anaconda/Miniconda install locations
for %%p in (
    "%USERPROFILE%\anaconda3"
    "%USERPROFILE%\miniconda3"
    "C:\ProgramData\anaconda3"
    "C:\ProgramData\miniconda3"
    "G:\ANACONDA"
    "D:\ANACONDA"
    "C:\ANACONDA"
    "%LOCALAPPDATA%\Programs\Python\Python313"
    "%LOCALAPPDATA%\Programs\Python\Python312"
    "%LOCALAPPDATA%\Programs\Python\Python311"
    "%LOCALAPPDATA%\Programs\Python\Python310"
    "C:\Python313"
    "C:\Python312"
    "C:\Python311"
    "C:\Python310"
) do (
    if exist "%%~p\python.exe" (
        if "!PY_FALLBACK!"=="" set "PY_FALLBACK=%%~p\python.exe"
        "%%~p\python.exe" -c "import flask" >nul 2>nul
        if !errorlevel! equ 0 (
            if exist "%%~p\pythonw.exe" (
                set "PY_EXE=%%~p\pythonw.exe"
            ) else (
                set "PY_EXE=%%~p\python.exe"
            )
            echo !PY_EXE!>"%~dp0.python_path"
            goto :LAUNCH
        )
    )
)

:: Priority 4: Python detected but missing flask -> auto-install requirements.txt
if not "!PY_FALLBACK!"=="" (
    echo ========================================================
    echo   [PaperLeaf 依赖检测]
    echo   检测到系统 Python: !PY_FALLBACK!
    echo   但尚未安装所需依赖库（Flask、Pillow、pypdf等）。
    echo ========================================================
    echo.
    echo   正在为您自动安装依赖，请稍候...
    echo.
    "!PY_FALLBACK!" -m pip install -r "%~dp0requirements.txt"
    if !errorlevel! equ 0 (
        if exist "!PY_FALLBACK:~0,-10!\pythonw.exe" (
            set "PY_EXE=!PY_FALLBACK:~0,-10!\pythonw.exe"
        ) else (
            set "PY_EXE=!PY_FALLBACK!"
        )
        echo !PY_EXE!>"%~dp0.python_path"
        goto :LAUNCH
    ) else (
        echo.
        echo   [自动安装失败] 请在终端手动运行:
        echo   pip install -r requirements.txt
        echo.
        pause
        exit /b 1
    )
)

:: Priority 5: No Python detected at all -> friendly guidance
echo ========================================================
echo   [PaperLeaf 启动提示] 未能在您的电脑上检测到 Python 环境！
echo ========================================================
echo.
echo   PaperLeaf 仅需普通 Python 即可运行：
echo   1. 前往 https://www.python.org/ 下载安装官方 Python 3.10+
echo   2. 安装时请勾选 "Add Python to PATH"
echo   3. 在此目录打开终端运行: pip install -r requirements.txt
echo   4. 再次双击 run.bat 即可一键启动！
echo.
echo ========================================================
pause
exit /b 1

:LAUNCH
start "" "%PY_EXE%" "%~dp0app.py"
exit
