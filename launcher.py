"""Source Code IDE launcher.

Runs the FastAPI server in a background thread and shows the IDE in a native
desktop window (pywebview / WebView2) — no browser needed. Falls back to the
system browser if a webview backend isn't available.

Startup strategy: show a splash window INSTANTLY (local HTML string, zero
network), then start the server in the background and navigate to the real
URL once ready. This eliminates the perceived "blank screen" wait.
"""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

# ---------- Splash HTML (inlined to avoid file-path issues) ----------
_SPLASH_HTML = """\
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Source Code IDE</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0e0e10;display:flex;align-items:center;justify-content:center;
height:100vh;font-family:'Segoe UI',system-ui,sans-serif;color:#c8ccd4;overflow:hidden}
.wrap{text-align:center}
.logo{font-size:64px;color:#7c6bf6;margin-bottom:24px;animation:pulse 2s ease-in-out infinite}
h1{font-size:22px;font-weight:500;letter-spacing:.4px;margin-bottom:10px}
p{font-size:13px;color:#6c7086;margin-bottom:32px}
.bar{width:200px;height:3px;background:#1e1e24;border-radius:3px;margin:0 auto;overflow:hidden;position:relative}
.bar::after{content:'';position:absolute;left:-40%;top:0;width:40%;height:100%;
background:linear-gradient(90deg,transparent,#7c6bf6,transparent);border-radius:3px;
animation:slide 1.2s ease-in-out infinite}
@keyframes slide{0%{left:-40%}100%{left:100%}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
</style></head><body>
<div class="wrap">
  <div class="logo">◆</div>
  <h1>Source Code IDE</h1>
  <p>Loading workspace…</p>
  <div class="bar"></div>
</div></body></html>
"""


def main():
    if getattr(sys, "frozen", False):
        os.environ.setdefault("IDE_STATIC", str(Path(sys._MEIPASS) / "static"))
    os.environ.setdefault("IDE_ROOT", os.getcwd())

    # --windowed builds have no console: sys.stdout/stderr are None and uvicorn
    # logging would crash on them. Redirect to a log file so the server runs.
    if sys.stdout is None or sys.stderr is None:
        _log = open(Path(tempfile.gettempdir()) / "sourcecodeide.log", "w", buffering=1, encoding="utf-8")
        sys.stdout = sys.stdout or _log
        sys.stderr = sys.stderr or _log

    port = int(os.getenv("IDE_PORT", "8770"))
    url = f"http://127.0.0.1:{port}"

    # ---- Show window IMMEDIATELY with inlined splash (no server needed) ----
    try:
        import webview

        window = webview.create_window(
            "Source Code IDE", html=_SPLASH_HTML,
            width=1480, height=940, min_size=(960, 620)
        )

        def _on_gui_ready():
            """Called by webview.start() once the GUI event loop is running.
            Boots the server in a daemon thread and navigates when ready."""

            def _boot():
                import httpx
                import uvicorn
                from ide import app

                config = uvicorn.Config(
                    app,
                    host="127.0.0.1",
                    port=port,
                    log_level="warning",
                    log_config={
                        "version": 1,
                        "disable_existing_loggers": False,
                        "formatters": {
                            "default": {"format": "%(levelname)s: %(message)s"}
                        },
                        "handlers": {
                            "default": {
                                "class": "logging.StreamHandler",
                                "formatter": "default"
                            }
                        },
                        "loggers": {
                            "uvicorn": {
                                "handlers": ["default"],
                                "level": "WARNING"
                            }
                        }
                    }
                )
                server = uvicorn.Server(config)
                threading.Thread(target=server.run, daemon=True).start()

                for _ in range(200):
                    try:
                        if httpx.get(url + "/api/health", timeout=0.5).status_code == 200:
                            break
                    except Exception:
                        time.sleep(0.15)

                print(f"Source Code IDE — {url}  (open folder: {os.environ['IDE_ROOT']})")
                window.load_url(url)

            threading.Thread(target=_boot, daemon=True).start()

        webview.start(func=_on_gui_ready, gui="edgechromium")

    except Exception as e:
        # Fallback: no webview — boot server then open browser
        import httpx
        import uvicorn
        from ide import app

        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = uvicorn.Server(config)
        threading.Thread(target=server.run, daemon=True).start()

        for _ in range(200):
            try:
                if httpx.get(url + "/api/health", timeout=0.5).status_code == 200:
                    break
            except Exception:
                time.sleep(0.15)

        import webbrowser
        print(f"Native window unavailable ({e}); opening in browser. Close this window to stop.")
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass

    os._exit(0)


if __name__ == "__main__":
    main()
