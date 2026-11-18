@echo off
setlocal enabledelayedexpansion
title Office Daily Cash Ledger - Push to GitHub
cd /d "%~dp0"

echo.
echo  ================================================
echo    PUSH THIS FOLDER TO GITHUB (backup + publish)
echo  ================================================
echo.
echo  Safe to run again and again. Your .env file is never uploaded.
echo.

where git >nul 2>nul
if !errorlevel! neq 0 (
    echo  Git is not installed. Opening the download page...
    start https://git-scm.com/download/win
    echo  Install it ^(default options are fine^), then run this file again.
    pause
    exit /b 1
)

if not exist ".git" (
    echo  First time: setting up Git in this folder...
    git init
    git branch -M main
)

git remote get-url origin >nul 2>nul
if !errorlevel! neq 0 (
    echo.
    echo  Create an EMPTY repository on github.com first ^(no README^),
    echo  then paste its address here, e.g.
    echo      https://github.com/YOURNAME/office-cash-ledger.git
    echo.
    set /p REPO_URL="  Repository address: "
    if "!REPO_URL!"=="" (
        echo  Nothing entered. Run this file again when you have it.
        pause
        exit /b 1
    )
    git remote add origin "!REPO_URL!"
)

git ls-files --error-unmatch .env >nul 2>nul
if !errorlevel! equ 0 (
    echo.
    echo  STOP: .env is being tracked by Git. Run:  git rm --cached .env
    echo  and try again. ^(Nothing was uploaded.^)
    pause
    exit /b 1
)

git add -A
set "MSG=Update %date% %time%"
git commit -m "!MSG!"
echo.
echo  Uploading to GitHub - a sign-in window may open the first time...
git push -u origin main
if !errorlevel! neq 0 (
    echo.
    echo  ERROR: push failed - scroll up for the real message.
    pause
    exit /b 1
)

echo.
echo  ================================================
echo    DONE. GitHub now has your latest code.
echo    Watch the publish progress in the repo's
echo    "Actions" tab; the live link appears there.
echo  ================================================
pause
endlocal
