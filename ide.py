"""Standalone coding IDE backend.

A small FastAPI app that powers a VS Code-style web IDE: real file tree,
open/edit/save, an AI coding agent (Ollama), a command terminal, and git
status badges. Serves its own static frontend. Packaged to a single exe.
"""
import json
import os
import re
import shutil
import string
import subprocess
import sys
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "")
TEXT_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss", ".html",
    ".json", ".md", ".txt", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".sh", ".bat",
    ".ps1", ".xml", ".svg", ".env", ".sql", ".rs", ".go", ".java", ".c", ".cpp", ".h",
    ".rb", ".php", ".vue", ".svelte", ".gitignore", ".dockerignore",
}
SKIP_DIRS = {
    "node_modules", ".git", ".venv", ".venv-build", "venv", "__pycache__", ".next",
    "out", "dist", "build", ".pytest_cache", ".idea", ".mypy_cache", ".gradle", "target",
}
MAX_BYTES = 2_000_000

_static_env = os.getenv("IDE_STATIC", "")
if _static_env:
    STATIC_DIR = Path(_static_env)
elif getattr(sys, "frozen", False):
    STATIC_DIR = Path(sys._MEIPASS) / "static"
else:
    STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# current open folder (server-side root for all file ops)
_state = {
    "root": Path(os.getenv("IDE_ROOT", "") or Path.home()).resolve(),
    "active_model": None
}
WORKSPACES = Path(os.getenv("LOCALAPPDATA") or Path.home()) / "SourceCodeIDE" / "workspaces"


def root() -> Path:
    return _state["root"]


def safe(rel: str) -> Path:
    target = (root() / rel).resolve()
    if not (str(target) == str(root()) or str(target).startswith(str(root()) + os.sep)):
        raise HTTPException(403, "path escapes the open folder")
    return target


app = FastAPI(
    title="Source Code IDE",
    openapi_url=None,
    docs_url=None,
    redoc_url=None
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ----------------------------------------------------------------------------- LLM
def list_models() -> list[dict]:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=3.0)
        out = []
        for m in r.json().get("models", []):
            name = m.get("name", "")
            if not name:
                continue
            out.append(
                {
                    "name": name,
                    "size": m.get("size", 0) or 0,
                    "is_embed": "embed" in name,
                    "is_cloud": name.endswith("cloud"),
                }
            )
        return out
    except Exception:
        return []


def resolve_model() -> str | None:
    active = _state.get("active_model")
    if active:
        return active
    models = list_models()
    names = {m["name"] for m in models}
    if OLLAMA_MODEL and (OLLAMA_MODEL in names or f"{OLLAMA_MODEL}:latest" in names):
        return OLLAMA_MODEL if OLLAMA_MODEL in names else f"{OLLAMA_MODEL}:latest"
    local = sorted([m for m in models if not m["is_cloud"] and not m["is_embed"]], key=lambda m: m["size"], reverse=True)
    if local:
        return local[0]["name"]
    return next((m["name"] for m in models if not m["is_embed"]), None)


def llm_available() -> bool:
    return len(list_models()) > 0


def llm_chat(messages: list[dict], model: str, max_tokens: int = 3500) -> str | None:
    try:
        r = httpx.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": model, "messages": messages, "stream": False, "options": {"num_predict": max_tokens}},
            timeout=300.0,
        )
        r.raise_for_status()
        return r.json()["message"]["content"]
    except Exception:
        return None


# ----------------------------------------------------------------------------- models
class RootIn(BaseModel):
    path: str


class FileIn(BaseModel):
    path: str
    content: str


class CreateIn(BaseModel):
    path: str
    kind: str = "file"


class RunIn(BaseModel):
    command: str


class AgentIn(BaseModel):
    instruction: str
    history: list[dict] = []


class ApplyIn(BaseModel):
    edits: list[dict]


# ----------------------------------------------------------------------------- workspace
@app.get("/api/ping")
def ping():
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "llm": llm_available(), "model": resolve_model(), "root": str(root())}


@app.get("/api/models")
def models():
    return {"models": list_models(), "active": resolve_model()}


class ActiveModelIn(BaseModel):
    name: str


@app.post("/api/models/active")
def set_active_model(body: ActiveModelIn):
    _state["active_model"] = body.name
    return {"ok": True, "active": _state["active_model"]}


@app.get("/api/root")
def get_root():
    r = root()
    return {"root": str(r), "name": r.name or str(r), "parent": str(r.parent) if r.parent != r else None}


@app.post("/api/root")
def set_root(body: RootIn):
    p = Path(body.path).expanduser()
    try:
        p = p.resolve()
    except Exception:
        raise HTTPException(400, "invalid path")
    if not p.is_dir():
        raise HTTPException(400, "not a folder")
    _state["root"] = p
    return get_root()


@app.post("/api/select-folder")
def select_folder():
    """Desktop app native folder picker using webview."""
    try:
        import webview
        win = webview.active_window()
        if win:
            res = win.create_file_dialog(webview.FOLDER_DIALOG)
            if res and len(res) > 0:
                p = Path(res[0]).resolve()
                if p.is_dir():
                    _state["root"] = p
                    return {"ok": True, "root": str(p), "name": p.name}
    except Exception as e:
        print("select_folder error:", e)
    return {"ok": False}


@app.get("/api/dirs")
def list_dirs(path: str = ""):
    """Folder picker: list drives at empty path, else subfolders."""
    if not path:
        if os.name == "nt":
            drives = [f"{d}:\\" for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
            return {"path": "", "parent": None, "dirs": [{"name": d, "path": d} for d in drives]}
        path = "/"
    p = Path(path).expanduser().resolve()
    if not p.is_dir():
        raise HTTPException(400, "not a folder")
    dirs = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                dirs.append({"name": child.name, "path": str(child)})
    except PermissionError:
        pass
    return {"path": str(p), "parent": str(p.parent) if p.parent != p else "", "dirs": dirs}


def _walk(base: Path) -> list[dict]:
    out = []
    for child in sorted(base.iterdir(), key=lambda c: (c.is_file(), c.name.lower())):
        if child.name in SKIP_DIRS:
            continue
        rel = child.relative_to(root()).as_posix()
        if child.is_dir():
            out.append({"path": rel, "name": child.name, "type": "dir"})
        else:
            out.append({"path": rel, "name": child.name, "type": "file"})
    return out


@app.get("/api/tree")
def tree(dir: str = ""):
    """Lazy tree: list one directory level (dir relative to root)."""
    base = safe(dir) if dir else root()
    if not base.is_dir():
        raise HTTPException(404, "not a directory")
    return {"dir": dir, "entries": _walk(base)}


@app.get("/api/file", response_class=PlainTextResponse)
def read_file(path: str):
    target = safe(path)
    if not target.is_file():
        raise HTTPException(404, "not found")
    if target.stat().st_size > MAX_BYTES:
        raise HTTPException(413, "file too large")
    return target.read_text(encoding="utf-8", errors="replace")


@app.put("/api/file")
def write_file(body: FileIn):
    target = safe(body.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return {"ok": True, "path": body.path}


@app.post("/api/create")
def create(body: CreateIn):
    target = safe(body.path)
    if body.kind == "dir":
        target.mkdir(parents=True, exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            target.write_text("", encoding="utf-8")
    return {"ok": True}


@app.get("/api/git")
def git_status():
    """Map of relative path -> single-letter status (M/A/D/U/?) + branch, for the
    explorer badges and the source-control / status-bar indicators."""
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain", "--branch"], cwd=str(root()), capture_output=True, text=True, timeout=8
        )
    except Exception:
        return {"available": False, "status": {}, "branch": ""}
    if out.returncode != 0:
        return {"available": False, "status": {}, "branch": ""}
    status, branch = {}, ""
    for line in out.stdout.splitlines():
        if line.startswith("##"):
            branch = line[3:].split("...")[0].strip()
            continue
        if len(line) < 4:
            continue
        code, name = line[:2].strip(), line[3:]
        status[name] = "U" if code == "??" else code[0]
    return {"available": True, "status": status, "branch": branch, "count": len(status)}


@app.post("/api/upload")
async def upload(files: list[UploadFile] = File(...), paths: str = Form(...), name: str = Form("workspace")):
    """Upload a folder from the user's machine and open it as the workspace.
    `paths` is a JSON array of webkitRelativePath strings, aligned with `files`."""
    rels = json.loads(paths)
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "workspace"
    base = WORKSPACES / safe_name
    if base.exists():
        shutil.rmtree(base, ignore_errors=True)
    base.mkdir(parents=True, exist_ok=True)

    written = 0
    for f, rel in zip(files, rels):
        rel = str(rel).lstrip("/").replace("\\", "/")
        if not rel or rel == "." or rel.endswith("/"):
            rel = f.filename or "file"
        target = (base / rel).resolve()
        if not str(target).startswith(str(base.resolve())):
            continue
        data = await f.read()
        if len(data) > MAX_BYTES:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        written += 1

    # the uploaded folder is the single top-level dir; open it directly
    top = rels[0].split("/")[0] if rels and rels[0] else ""
    new_root = (base / top).resolve() if top and (base / top).is_dir() else base.resolve()
    _state["root"] = new_root
    return {"root": str(new_root), "name": new_root.name, "files": written}


@app.post("/api/run")
def run_command(body: RunIn):
    try:
        proc = subprocess.run(
            body.command, cwd=str(root()), shell=True, capture_output=True, text=True, timeout=120
        )
        return {"code": proc.returncode, "stdout": proc.stdout[-20000:], "stderr": proc.stderr[-20000:]}
    except subprocess.TimeoutExpired:
        return {"code": -1, "stdout": "", "stderr": "command timed out (120s)"}
    except Exception as e:
        return {"code": -1, "stdout": "", "stderr": str(e)}


# ----------------------------------------------------------------------------- agent
AGENT_SYSTEM = """You are a coding agent inside an IDE, working in the open folder.
Reply with ONE JSON object and nothing else.
Read a file: {{"action":"read","path":"relative/path"}}
Write a file: {{"action":"write","path":"relative/path","content":"COMPLETE new file content"}}
Run a command: {{"action":"shell","command":"python hello.py"}}
Finish: {{"action":"finish","message":"<short>","edits":[{{"path":"relative/path","content":"<COMPLETE new file content>"}}]}}
For a question with no change, finish with "edits":[].
Rules: paths are relative to the open folder; you should read a file before editing it; you can run shell commands to compile, test, or verify.
Files in the open folder:
{tree}"""


def _full_tree(limit: int = 400) -> list[str]:
    out = []
    for p in root().rglob("*"):
        if not p.is_file():
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(root()).parts):
            continue
        if p.suffix.lower() in TEXT_EXTS or p.name in TEXT_EXTS:
            out.append(p.relative_to(root()).as_posix())
        if len(out) >= limit:
            break
    return out


def _unescape_val(val):
    if isinstance(val, str):
        return val.replace('\\"', '"').replace('\\n', '\n').replace('\\t', '\t').replace('\\\\', '\\')
    elif isinstance(val, list):
        return [_unescape_val(x) for x in val]
    elif isinstance(val, dict):
        return {k: _unescape_val(v) for k, v in val.items()}
    return val


def _parse(raw: str):
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    content_str = m.group(0)
    try:
        obj = json.loads(content_str)
        return _unescape_val(obj)
    except ValueError:
        pass
    try:
        cleaned = content_str.replace("\n", "\\n")
        obj = json.loads(cleaned)
        return _unescape_val(obj)
    except ValueError:
        pass

    # Fallback to custom field extractor for malformed LLM JSON actions
    action_match = re.search(r'"action"\s*:\s*"([^"]+)"', content_str)
    if not action_match:
        return None
    action = action_match.group(1)
    result = {"action": action}
    
    path_match = re.search(r'"path"\s*:\s*"([^"]+)"', content_str)
    if path_match:
        result["path"] = path_match.group(1)
        
    for field in ("content", "command", "query", "text", "message"):
        field_pattern = r'"' + field + r'"\s*:\s*'
        field_match = re.search(field_pattern, content_str)
        if field_match:
            start_idx = field_match.end()
            val_remainder = content_str[start_idx:].strip()
            
            quotes_count = 0
            if val_remainder.startswith('"""'):
                quotes_count = 3
            elif val_remainder.startswith('"'):
                quotes_count = 1
                
            val_str = val_remainder[quotes_count:]
            
            end_brace = val_str.rfind('}')
            if end_brace != -1:
                val_str = val_str[:end_brace].rstrip()
                
            if val_str.endswith('"'):
                val_str = val_str[:-1]
                
            if val_str.startswith('""') and not val_str.startswith('"""'):
                val_str = '"' + val_str
            if val_str.endswith('""') and not val_str.endswith('"""'):
                val_str = val_str + '"'
                
            val_str = val_str.replace('\\"', '"').replace('\\n', '\n').replace('\\t', '\t').replace('\\\\', '\\')
            result[field] = val_str
            break
            
    # Also handle the "edits" list if present in malformed finished action
    edits_match = re.search(r'"edits"\s*:\s*\[(.*)\]', content_str, re.DOTALL)
    if edits_match:
        try:
            edits_txt = "[" + edits_match.group(1) + "]"
            result["edits"] = _unescape_val(json.loads(edits_txt))
        except Exception:
            pass
            
    return _unescape_val(result)


def _diff(path, old, new):
    import difflib

    return "".join(
        difflib.unified_diff(old.splitlines(keepends=True), new.splitlines(keepends=True), f"a/{path}", f"b/{path}", n=2)
    )[:12000]


@app.post("/api/agent")
def agent(body: AgentIn):
    model = resolve_model()
    if not model:
        return {"message": "Ollama isn't connected. Start it (ollama serve) and pull a model.", "steps": [], "edits": []}

    tree_txt = "\n".join(_full_tree())
    messages = [{"role": "system", "content": AGENT_SYSTEM.format(tree=tree_txt[:9000])}]
    for h in body.history[-8:]:
        messages.append({"role": h.get("role", "user"), "content": str(h.get("content", ""))[:4000]})
    messages.append({"role": "user", "content": body.instruction})

    steps = []
    for _ in range(6):
        raw = llm_chat(messages, model)
        if not raw:
            return {"message": "The model did not respond.", "steps": steps, "edits": []}
        obj = _parse(raw)
        if not obj or "action" not in obj:
            return {"message": raw.strip(), "steps": steps, "edits": []}
        if obj["action"] == "read":
            rel = str(obj.get("path", ""))
            try:
                content = safe(rel).read_text(encoding="utf-8", errors="replace")[:8000]
                ok = True
            except Exception:
                content, ok = f"(could not read {rel})", False
            steps.append({"action": "read", "path": rel, "ok": ok})
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": f"Contents of {rel}:\n\n{content}"})
            continue
        if obj["action"] == "write":
            rel = str(obj.get("path", ""))
            content = str(obj.get("content", ""))
            try:
                target = safe(rel)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
                msg = f"Successfully wrote {rel} ({len(content)} chars)"
                ok = True
            except Exception as e:
                msg = f"Error writing {rel}: {e}"
                ok = False
            steps.append({"action": "write", "path": rel, "ok": ok})
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": msg})
            continue
        if obj["action"] == "shell":
            cmd = str(obj.get("command", ""))
            try:
                proc = subprocess.run(
                    cmd, cwd=str(root()), shell=True, capture_output=True, text=True, timeout=60
                )
                msg = f"Exit code {proc.returncode}\nStdout:\n{proc.stdout[-4000:]}\nStderr:\n{proc.stderr[-4000:]}"
                ok = True
            except Exception as e:
                msg = f"Error running command: {e}"
                ok = False
            steps.append({"action": "shell", "path": cmd, "ok": ok})
            messages.append({"role": "assistant", "content": raw})
            messages.append({"role": "user", "content": msg})
            continue
        if obj["action"] == "finish":
            edits = []
            for e in (obj.get("edits") or [])[:8]:
                rel = str(e.get("path", ""))
                new = str(e.get("content", ""))
                if not rel:
                    continue
                try:
                    target = safe(rel)
                    old = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else ""
                except Exception:
                    continue
                if old == new:
                    continue
                edits.append({"path": rel, "kind": "create" if old == "" else "edit", "new_content": new, "diff": _diff(rel, old, new)})
            return {"message": str(obj.get("message", "")), "steps": steps, "edits": edits}
        return {"message": raw.strip(), "steps": steps, "edits": []}
    return {"message": "Reached step limit.", "steps": steps, "edits": []}


def _resolve_edits(raw: str, steps: list) -> dict:
    """Parse a finished agent response and build the edits/message payload."""
    obj = _parse(raw)
    if not obj or "action" not in obj:
        return {"message": raw.strip(), "steps": steps, "edits": []}
    if obj["action"] == "finish":
        edits = []
        for e in (obj.get("edits") or [])[:8]:
            rel = str(e.get("path", ""))
            new = str(e.get("content", ""))
            if not rel:
                continue
            try:
                target = safe(rel)
                old = target.read_text(encoding="utf-8", errors="replace") if target.is_file() else ""
            except Exception:
                continue
            if old == new:
                continue
            edits.append({"path": rel, "kind": "create" if old == "" else "edit",
                          "new_content": new, "diff": _diff(rel, old, new)})
        return {"message": str(obj.get("message", "")), "steps": steps, "edits": edits}
    return {"message": raw.strip(), "steps": steps, "edits": []}


@app.post("/api/agent/stream")
async def agent_stream(body: AgentIn):
    """SSE endpoint: streams tokens in real-time, then sends the final result."""
    model = resolve_model()

    async def _generate():
        if not model:
            yield f"data: {json.dumps({'type': 'done', 'message': 'Ollama is not connected. Start it (ollama serve) and pull a model.', 'steps': [], 'edits': []})}\n\n"
            return

        tree_txt = "\n".join(_full_tree())
        messages = [{"role": "system", "content": AGENT_SYSTEM.format(tree=tree_txt[:9000])}]
        for h in body.history[-8:]:
            messages.append({"role": h.get("role", "user"), "content": str(h.get("content", ""))[:4000]})
        messages.append({"role": "user", "content": body.instruction})

        steps = []
        for _round in range(6):
            # Stream from Ollama
            yield f"data: {json.dumps({'type': 'status', 'status': 'thinking'})}\n\n"
            full = ""
            try:
                with httpx.stream(
                    "POST", f"{OLLAMA_URL}/api/chat",
                    json={"model": model, "messages": messages, "stream": True,
                          "options": {"num_predict": 3500}},
                    timeout=300.0
                ) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except ValueError:
                            continue
                        token = chunk.get("message", {}).get("content", "")
                        if token:
                            full += token
                            yield f"data: {json.dumps({'type': 'token', 'token': token})}\n\n"
                        if chunk.get("done"):
                            break
            except Exception:
                yield f"data: {json.dumps({'type': 'done', 'message': 'The model did not respond.', 'steps': steps, 'edits': []})}\n\n"
                return

            if not full:
                yield f"data: {json.dumps({'type': 'done', 'message': 'The model did not respond.', 'steps': steps, 'edits': []})}\n\n"
                return

            obj = _parse(full)
            if not obj or "action" not in obj:
                # Plain text answer — send as done
                yield f"data: {json.dumps({'type': 'done', 'message': full.strip(), 'steps': steps, 'edits': []})}\n\n"
                return

            if obj["action"] == "read":
                rel = str(obj.get("path", ""))
                yield f"data: {json.dumps({'type': 'tool_start', 'action': 'read', 'path': rel})}\n\n"
                try:
                    content = safe(rel).read_text(encoding="utf-8", errors="replace")[:8000]
                    ok = True
                except Exception:
                    content, ok = f"(could not read {rel})", False
                steps.append({"action": "read", "path": rel, "ok": ok})
                yield f"data: {json.dumps({'type': 'step', 'step': steps[-1]})}\n\n"
                messages.append({"role": "assistant", "content": full})
                messages.append({"role": "user", "content": f"Contents of {rel}:\n\n{content}"})
                # Clear streamed text for the next round
                yield f"data: {json.dumps({'type': 'clear'})}\n\n"
                continue

            if obj["action"] == "write":
                rel = str(obj.get("path", ""))
                content = str(obj.get("content", ""))
                yield f"data: {json.dumps({'type': 'tool_start', 'action': 'write', 'path': rel})}\n\n"
                try:
                    target = safe(rel)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
                    msg = f"Successfully wrote {rel} ({len(content)} chars)"
                    ok = True
                except Exception as e:
                    msg = f"Error writing {rel}: {e}"
                    ok = False
                steps.append({"action": "write", "path": rel, "ok": ok})
                yield f"data: {json.dumps({'type': 'step', 'step': steps[-1]})}\n\n"
                messages.append({"role": "assistant", "content": full})
                messages.append({"role": "user", "content": msg})
                yield f"data: {json.dumps({'type': 'clear'})}\n\n"
                continue

            if obj["action"] == "shell":
                cmd = str(obj.get("command", ""))
                yield f"data: {json.dumps({'type': 'tool_start', 'action': 'shell', 'command': cmd})}\n\n"
                try:
                    proc = subprocess.run(
                        cmd, cwd=str(root()), shell=True, capture_output=True, text=True, timeout=60
                    )
                    msg = f"Exit code {proc.returncode}\nStdout:\n{proc.stdout[-4000:]}\nStderr:\n{proc.stderr[-4000:]}"
                    ok = True
                except Exception as e:
                    msg = f"Error running command: {e}"
                    ok = False
                steps.append({"action": "shell", "path": cmd, "ok": ok})
                yield f"data: {json.dumps({'type': 'step', 'step': steps[-1]})}\n\n"
                messages.append({"role": "assistant", "content": full})
                messages.append({"role": "user", "content": msg})
                yield f"data: {json.dumps({'type': 'clear'})}\n\n"
                continue

            if obj["action"] == "finish":
                result = _resolve_edits(full, steps)
                yield f"data: {json.dumps({'type': 'done', **result})}\n\n"
                return

            yield f"data: {json.dumps({'type': 'done', 'message': full.strip(), 'steps': steps, 'edits': []})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'done', 'message': 'Reached step limit.', 'steps': steps, 'edits': []})}\n\n"

    return StreamingResponse(_generate(), media_type="text/event-stream")


@app.post("/api/agent/apply")
def agent_apply(body: ApplyIn):
    applied, errors = [], []
    for e in body.edits:
        rel = str(e.get("path", ""))
        try:
            target = safe(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(str(e.get("new_content", "")), encoding="utf-8")
            applied.append(rel)
        except Exception as ex:
            errors.append({"path": rel, "error": str(ex)})
    return {"applied": applied, "errors": errors}


# ----------------------------------------------------------------------------- static
@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/{full_path:path}", include_in_schema=False)
def assets(full_path: str):
    target = (STATIC_DIR / full_path).resolve()
    if str(target).startswith(str(Path(STATIC_DIR).resolve())) and target.is_file():
        return FileResponse(target)
    return FileResponse(STATIC_DIR / "index.html")
