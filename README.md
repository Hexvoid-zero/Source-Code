<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/f96e6bd5-02ec-4127-9a8a-5bca06d62ff1" />
# Source Code IDE

A standalone, VS Code / Antigravity-style coding IDE with a built-in AI coding agent.
Part of the SourceMind project, but ships as its own program and its own `.exe`.

![IDE](docs/ide.png)

## What it does

- **File explorer** with live git status badges (M / U / A)
- **Monaco editor** — the editor that powers VS Code: syntax highlighting, line numbers, minimap, multi-tab editing
- **Open any folder** on disk (folder picker), edit and save files
- **AI coding agent** — ask it to change code; it reads files, proposes complete-file diffs, and writes them only when you click **Apply** (powered by your local Ollama)
- **Integrated terminal** — run shell commands in the open folder
- **Menus, breadcrumbs, status bar** — the usual IDE chrome

Everything runs locally. The agent uses [Ollama](https://ollama.com) if it's running; the rest works without it.

## Run from source

```bash
# 1. bundle the editor
npm install
#    copy Monaco into static/vs  (build.ps1 does this for you)

# 2. backend
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python launcher.py     # opens http://127.0.0.1:8770
```

By default the IDE opens the folder it was launched from. Use **File → Open Folder…** to switch.

## Build the standalone .exe

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
# -> dist\SourceCodeIDE.exe
```

Double-click `SourceCodeIDE.exe`: it starts the server, waits until it's ready, and opens the IDE in your browser. It edits the folder the exe is launched from (or any folder you open).

## Note

The terminal and the agent's Apply action write to your real filesystem within the open folder. It's a local developer tool — run it on folders you own.
