@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  set /p LINK=Paste Douyin link, then press Enter: 
) else (
  set "LINK=%~1"
)
node "%~dp0scripts\douyin-dl.mjs" "%LINK%"
echo.
pause
