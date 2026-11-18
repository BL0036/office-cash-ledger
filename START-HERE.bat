@echo off
setlocal enabledelayedexpansion
title Office Daily Cash Ledger - Setup and Deploy
color 0A

echo.
echo  ================================================
echo    OFFICE DAILY CASH LEDGER
echo    One-Click Setup, Build ^& Deploy
echo  ================================================
echo.
echo  This will set up everything needed to run this app
echo  and put it online. It's safe to run more than once -
echo  it skips anything already done.
echo.
pause

cd /d "%~dp0"

REM ============================================================
REM  STEP 1 - Node.js
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 1 of 8 - Checking for Node.js
echo  --------------------------------------------------
where node >nul 2>nul
if !errorlevel! equ 0 (
    for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
    echo   Found Node.js !NODE_VERSION! - good.
    goto :step2
)

echo   Not found. Trying to install it automatically...
where winget >nul 2>nul
if !errorlevel! neq 0 (
    echo.
    echo   Could not install automatically on this PC.
    echo   Opening the Node.js download page for you...
    start https://nodejs.org/en/download
    echo.
    echo   Please install it there ^(choose the LTS version^), RESTART
    echo   your PC, then double-click this file again.
    echo.
    pause
    exit /b 1
)

echo   Installing Node.js LTS - approve the Windows prompt if one appears.
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if !errorlevel! neq 0 (
    echo.
    echo   Node.js was installed, but this window can't see it yet.
    echo   Please CLOSE this window and double-click this file again
    echo   ^(just this once - it will continue normally after that^).
    echo.
    pause
    exit /b 0
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo   Node.js !NODE_VERSION! installed successfully.

:step2
REM ============================================================
REM  STEP 2 - npm check
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 2 of 8 - Checking for npm
echo  --------------------------------------------------
where npm >nul 2>nul
if !errorlevel! neq 0 (
    echo   ERROR: npm not found even though Node.js is installed.
    echo   Try reinstalling Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo   Found npm - good.

if not exist "package.json" (
    echo.
    echo   ERROR: This .bat file is not inside the project folder.
    echo   Make sure START-HERE.bat sits next to "package.json".
    pause
    exit /b 1
)

REM ============================================================
REM  STEP 3 - Cloud Sync .env check (informational only)
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 3 of 8 - Checking Cloud Sync setup
echo  --------------------------------------------------
if exist ".env" (
    echo   Found a .env file - Cloud Sync settings will be included.
) else (
    echo   No .env file found - that's fine, the app will just run in
    echo   offline/single-device mode. See README.md if you want to
    echo   add Cloud Sync later ^(copy .env.example to .env and fill it in,
    echo   then run this file again^).
)

REM ============================================================
REM  STEP 4 - npm install
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 4 of 8 - Installing dependencies
echo  --------------------------------------------------
echo   This can take a few minutes the first time. Please wait...
echo.
call npm install
if !errorlevel! neq 0 (
    echo.
    echo   ERROR: "npm install" failed - scroll up for the actual error.
    echo   Try: delete the "node_modules" folder if it exists, make sure
    echo   you're connected to the internet, then run this file again.
    pause
    exit /b 1
)
echo   Done.

REM ============================================================
REM  STEP 5 - Build
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 5 of 8 - Building the app
echo  --------------------------------------------------
call npm run build
if !errorlevel! neq 0 (
    echo.
    echo   ERROR: Build failed - scroll up for the actual error.
    pause
    exit /b 1
)
if not exist "dist" (
    echo   ERROR: Build finished but no "dist" folder appeared.
    pause
    exit /b 1
)
echo   Build succeeded.

REM ============================================================
REM  STEP 6 - Firebase CLI
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 6 of 8 - Checking the Firebase tool
echo  --------------------------------------------------
where firebase >nul 2>nul
if !errorlevel! equ 0 (
    echo   Already installed.
) else (
    echo   Installing it now ^(one-time only^)...
    call npm install -g firebase-tools
    if !errorlevel! neq 0 (
        echo   ERROR: Could not install the Firebase tool.
        pause
        exit /b 1
    )
    echo   Installed.
)

REM ============================================================
REM  STEP 7 - Firebase login
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 7 of 8 - Firebase login
echo  --------------------------------------------------
firebase login:list 2>nul | findstr /i "@" >nul
if !errorlevel! equ 0 (
    echo   Already logged in.
) else (
    echo   Opening your browser to sign in - use the same Google
    echo   account as your Firebase project.
    call firebase login >nul 2>nul
    firebase login:list 2>nul | findstr /i "@" >nul
    if !errorlevel! neq 0 (
        echo.
        echo   Login did not complete. Please run this file again.
        pause
        exit /b 1
    )
    echo   Logged in successfully.
)

REM ============================================================
REM  STEP 8 - Connect project + Deploy
REM ============================================================
echo.
echo  --------------------------------------------------
echo   STEP 8 of 8 - Connecting and deploying
echo  --------------------------------------------------
if not exist ".firebaserc" (
    echo.
    echo   This folder isn't connected to a Firebase project yet.
    echo   IMPORTANT: you must have already created a Firebase project
    echo   in your browser at console.firebase.google.com before this
    echo   step will work - see README.md if you haven't done that.
    echo.
    echo   A list of your Firebase projects will appear below - use the
    echo   arrow keys to pick the right one and press Enter.
    echo.
    call firebase use --add
    if !errorlevel! neq 0 (
        echo.
        echo   ERROR: Could not connect to a Firebase project.
        pause
        exit /b 1
    )
) else (
    echo   Already connected to a Firebase project.
)

echo.
echo   Deploying now...
echo.
call firebase deploy
if !errorlevel! neq 0 (
    echo.
    echo   ERROR: Deploy failed - scroll up for the actual error.
    pause
    exit /b 1
)

if exist ".env" (
    echo.
    echo   Also deploying your Cloud Sync security rules...
    call firebase deploy --only firestore:rules
)

echo.
echo  ================================================
echo    SUCCESS! Your app is live.
echo  ================================================
echo.
echo  Look a few lines above for "Hosting URL:" - that's your
echo  app's live web address. Open it on your phone and use
echo  "Add to Home Screen" to install it like a normal app.
echo.
echo  To publish an update later: just double-click this file
echo  again after replacing these files with a newer version.
echo.
pause
endlocal
