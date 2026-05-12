@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  echo Download: https://nodejs.org/
  pause
  exit /b 1
)

echo Starting ASXS local proxy...
echo.
echo Open this page:
echo   http://localhost:8791/index.html
echo.
echo In the page, use:
echo   Base URL: http://localhost:8791/v1
echo   API endpoint: /responses
echo   Proxy Upstream: choose ÇþµÀ1, ÇþµÀ2, or ÇþµÀ3
echo.
echo Press Ctrl+C in this window to stop the server.
echo.

node "%~dp0server.mjs"

echo.
echo Server stopped.
pause
