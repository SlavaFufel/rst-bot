@echo off
REM Build the pairing helper into a single Windows .exe with the ingest URL baked in.
REM Usage:  build.cmd https://your-tunnel.example.com/pair/ingest
setlocal

if "%~1"=="" (
  echo Usage: build.cmd ^<PUBLIC_INGEST_URL^>
  echo Example: build.cmd https://rst-pair.trycloudflare.com/pair/ingest
  exit /b 1
)

echo Baking ingest URL: %~1
> src\ingest-url.txt echo|set /p="%~1"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

echo Building rst-pair.exe...
call npx @yao-pkg/pkg . --targets node22-win-x64 --output build\rst-pair.exe

echo.
echo Done: build\rst-pair.exe
endlocal
