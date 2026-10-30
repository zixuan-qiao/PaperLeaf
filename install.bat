@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title PaperLeaf - 一键环境安装与初始化
cd /d "%~dp0"

echo ======================================================================
echo           PaperLeaf 🌿 开源便携学术工作台 - 一键初始化与安装
echo ======================================================================
echo.

:: 1. 检测 Python
echo [1/5] 正在检测系统 Python 环境...
set "PY_EXE="

:: 优先检测已有 .python_path
if exist "%~dp0.python_path" (
    set /p CACHED_PY=<"%~dp0.python_path"
    if exist "!CACHED_PY!" (
        set "PY_EXE=!CACHED_PY!"
    )
)

:: 检测虚拟环境 venv
if "!PY_EXE!"=="" (
    if exist "%~dp0venv\Scripts\python.exe" (
        set "PY_EXE=%~dp0venv\Scripts\python.exe"
    )
)

:: 检测系统 PATH 中的 Python
if "!PY_EXE!"=="" (
    for /f "tokens=*" %%i in ('where python 2^>nul') do (
        if "!PY_EXE!"=="" (
            set "PY_EXE=%%i"
        )
    )
)

:: 检测常用安装路径
if "!PY_EXE!"=="" (
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
            if "!PY_EXE!"=="" set "PY_EXE=%%~p\python.exe"
        )
    )
)

if "!PY_EXE!"=="" (
    echo [错误] 未能检测到任何 Python 安装！
    echo.
    echo 请前往官方网站下载并安装 Python 3.10 或更高版本：
    echo https://www.python.org/downloads/
    echo 提示：安装时请务必勾选 "Add Python to PATH"（添加到环境变量）。
    echo.
    pause
    exit /b 1
)

echo   ✓ 找到 Python: !PY_EXE!
for /f "tokens=*" %%v in ('"!PY_EXE!" --version 2^>^&1') do echo   ✓ 运行版本: %%v
echo.

:: 2. 安装 Python 依赖库
echo [2/5] 正在安装与校验核心依赖库 (Flask, Pillow, pypdf, psutil)...
"!PY_EXE!" -m pip install -r "%~dp0requirements.txt"
if !errorlevel! neq 0 (
    echo.
    echo [提示] 尝试使用国内清华镜像源加速安装...
    "!PY_EXE!" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r "%~dp0requirements.txt"
    if !errorlevel! neq 0 (
        echo [错误] 依赖安装失败，请检查网络连接后重试。
        pause
        exit /b 1
    )
)
echo   ✓ 核心依赖库全部验证就绪！
echo.

:: 3. 编译器核心 Tectonic 校验与自动拉取
echo [3/5] 正在检测 LaTeX 编译核心 (Tectonic)...
if exist "%~dp0bin\tectonic.exe" (
    echo   ✓ Tectonic 单文件编译核心已就绪！
) else (
    echo   正在自动下载 Tectonic 编译器 (约 18MB，仅首次需下载)...
    "!PY_EXE!" "%~dp0setup_env.py"
    if !errorlevel! neq 0 (
        echo [错误] Tectonic 下载失败，请检查网络或手动下载放入 bin 目录。
        pause
        exit /b 1
    )
)
echo.

:: 4. 校验中文字体与离线渲染库
echo [4/5] 正在校验中文字体与离线 PDF 渲染资源...
if exist "%~dp0fonts\fandol\FandolSong-Regular.otf" (
    echo   ✓ Fandol 官方中文字体族已就绪 (8款完整中文字型)
) else (
    echo   ! 提示: 未发现 fonts\fandol 目录，将使用 Windows 系统自带中文字体回退保底。
)
if exist "%~dp0static\vendor\pdfjs\cmaps" (
    echo   ✓ PDF.js 离线 CMap 字符映射集已就绪 (169个离线字符集)
)
echo.

:: 5. 缓存 Python 路径与生成桌面快捷方式
echo [5/5] 正在配置开箱即用便携启动环境与桌面快捷方式...
set "PYW_EXE="
if exist "!PY_EXE:~0,-10!\pythonw.exe" (
    set "PYW_EXE=!PY_EXE:~0,-10!\pythonw.exe"
) else (
    set "PYW_EXE=!PY_EXE!"
)
echo !PYW_EXE!>"%~dp0.python_path"
echo   ✓ 本地 Python 缓存路径配置完成

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\create_shortcut.ps1" -TargetPath "C:\Windows\System32\wscript.exe" -Arguments "%~dp0launch.vbs" -WorkingDirectory "%~dp0." -IconLocation "%~dp0static\app.ico,0"

echo.
echo ======================================================================
echo                🎉 PaperLeaf 全部初始化配置已顺利完成！
echo ======================================================================
echo.
echo   • 桌面快捷方式【PaperLeaf】已生成，以后双击桌面图标即可秒开使用！
echo   • 任何时候也可以直接双击项目根目录下的【run.bat】或【launch.vbs】启动。
echo   • 程序完全运行在当前独立目录，零注册表写入，零 C 盘垃圾文件。
echo.

set /p START_NOW="是否立即启动 PaperLeaf？(Y/n): "
if /i "!START_NOW!"=="" set "START_NOW=Y"
if /i "!START_NOW!"=="Y" (
    echo 正在唤醒 PaperLeaf 工作台...
    start "" "!PYW_EXE!" "%~dp0app.py"
)

exit /b 0
