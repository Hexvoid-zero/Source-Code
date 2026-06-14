# Build the Source Code IDE into a standalone Windows .exe.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
Set-Location $PSScriptRoot

Write-Host "1/3  Bundling Monaco editor…"
npm install --no-fund --no-audit
Remove-Item -Recurse -Force static\vs -ErrorAction SilentlyContinue
Copy-Item -Recurse node_modules\monaco-editor\min\vs static\vs

Write-Host "2/3  Preparing Python build env…"
if (-not (Test-Path .venv-build)) { python -m venv .venv-build }
.\.venv-build\Scripts\python.exe -m pip install -q -r backend\requirements.txt pyinstaller

Write-Host "3/3  Packaging exe (onedir = fast startup)…"
Remove-Item -Recurse -Force build, dist, SourceCodeIDE.spec -ErrorAction SilentlyContinue
# --onedir starts instantly (no per-launch unpacking); the app lives in dist\SourceCodeIDE\
.\.venv-build\Scripts\python.exe -m PyInstaller --noconfirm --onedir --windowed --optimize 2 --name SourceCodeIDE `
  --icon SourceCodeIDE.ico `
  --add-data "static;static" --collect-submodules uvicorn `
  --collect-all webview --collect-all clr_loader --collect-all pythonnet --hidden-import clr `
  --paths backend backend\launcher.py

Write-Host "Done -> dist\SourceCodeIDE\SourceCodeIDE.exe"
