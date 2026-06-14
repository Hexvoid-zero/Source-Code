"use strict";

// --------------------------------------------------------------------------- api (with retry on transient network/server errors)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rfetch(url, opts, tries) {
  tries = tries || 5;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      // Retry on connection drops or typical transient server errors
      if (!res.ok && [408, 500, 502, 503, 504].includes(res.status)) {
        if (i < tries - 1) { await sleep(400 * (i + 1)); continue; }
      }
      return res;
    } catch (e) {
      if (i < tries - 1) { await sleep(400 * (i + 1)); continue; }
      throw e;
    }
  }
}
async function api(path, opts) {
  const res = await rfetch("/api" + path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}
async function apiText(path) {
  const res = await rfetch("/api" + path);
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}

// --------------------------------------------------------------------------- icons
const SVG = {
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
};

// --------------------------------------------------------------------------- state
const S = { root: "", tabs: [], active: null, expanded: {}, git: {} };
let editor = null;
const $ = (id) => document.getElementById(id);

const LANG = { js:"javascript", jsx:"javascript", mjs:"javascript", cjs:"javascript", ts:"typescript", tsx:"typescript",
  json:"json", html:"html", css:"css", scss:"scss", md:"markdown", py:"python", sh:"shell", bat:"bat", ps1:"powershell",
  yml:"yaml", yaml:"yaml", xml:"xml", svg:"xml", sql:"sql", rs:"rust", go:"go", java:"java", c:"c", cpp:"cpp", h:"cpp",
  rb:"ruby", php:"php", vue:"html", toml:"ini" };
const langOf = (p) => LANG[(p.split(".").pop() || "").toLowerCase()] || "plaintext";

function toast(msg, ms) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms || 2600);
}

// --------------------------------------------------------------------------- boot
require(["vs/editor/editor.main"], async function () {
  monaco.editor.defineTheme("sc-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "a9adb6" },
      { token: "comment", foreground: "575c66", fontStyle: "italic" },
      { token: "keyword", foreground: "c678dd" },
      { token: "string", foreground: "98c379" },
      { token: "number", foreground: "d19a66" },
      { token: "type", foreground: "e5c07b" },
      { token: "class", foreground: "e5c07b" },
      { token: "function", foreground: "61afef" },
    ],
    colors: {
      "editor.background": "#0e0e11",
      "editorGutter.background": "#0e0e11",
      "editorLineNumber.foreground": "#3b3b4f",
      "editorLineNumber.activeForeground": "#3b82f6",
      "minimap.background": "#0e0e11",
      "editor.lineHighlightBackground": "#16161f",
      "editor.selectionBackground": "#264f78",
      "editorCursor.foreground": "#528bff",
    },
  });
  editor = monaco.editor.create($("editor"), {
    theme: "sc-dark", automaticLayout: true, fontSize: 13, lineHeight: 20, minimap: { enabled: true },
    scrollBeyondLastLine: false, renderWhitespace: "none", value: "", language: "plaintext",
    padding: { top: 6 }, smoothScrolling: true,
  });
  editor.onDidChangeModelContent(() => {
    const t = S.tabs.find((x) => x.path === S.active);
    if (t && !t.dirty) { t.dirty = true; renderTabs(); }
  });
  editor.onDidChangeCursorPosition((e) => {
    $("stPos").textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    updateBreadcrumb(e.position.lineNumber);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
  await boot();
});

async function boot() {
  try {
    const h = await api("/health");
    $("stModel").textContent = h.llm ? `LLM ${h.model || ""}` : "LLM offline";
    $("llmChip").classList.toggle("off", !h.llm);
  } catch (e) {
    console.error("Health check failed:", e);
    $("stModel").textContent = "LLM offline";
    $("llmChip").classList.add("off");
  }
  
  try {
    await loadModels();
  } catch (e) {
    console.error("Failed to load models:", e);
  }
  
  try {
    await refreshRoot();
  } catch (e) {
    console.error("Failed to refresh root:", e);
    toast("Connection error. Retrying in 3 seconds...", 3000);
    setTimeout(boot, 3000);
  }
}

async function refreshRoot() {
  const r = await api("/root");
  S.root = r.root;
  $("winTitle").textContent = `${r.name} — Source Code IDE`;
  $("projectName").textContent = (r.name || "workspace").toUpperCase();
  $("dockProject").textContent = r.name || "workspace";
  S.expanded = {};
  await loadGit();
  await expandDir("");
  renderTree();
  updateWelcome();
}

// --------------------------------------------------------------------------- git
async function loadGit() {
  try {
    const g = await api("/git");
    S.git = g.status || {};
    const n = g.count || 0;
    const b = $("scBadge"); b.textContent = n; b.hidden = n === 0;
    $("stBranch").textContent = "⑂ " + (g.branch || "—");
  } catch (e) { S.git = {}; }
}

// --------------------------------------------------------------------------- explorer
async function expandDir(dir) {
  try {
    const t = await api("/tree?dir=" + encodeURIComponent(dir));
    S.expanded[dir] = t.entries;
  } catch (e) {
    console.error("Failed to expand directory:", e);
    toast("Failed to load directory " + dir);
  }
}
function renderTree() {
  const el = $("tree"); el.innerHTML = "";
  renderLevel(el, "", 0);
}
function renderLevel(container, dir, depth) {
  const entries = S.expanded[dir];
  if (!entries) return;
  for (const e of entries) {
    const isOpen = e.type === "dir" && S.expanded[e.path];
    const badge = S.git[e.path];
    const row = document.createElement("div");
    row.className = "row" + (e.path === S.active ? " active" : "") + (badge ? " git-" + badge : "");
    row.style.paddingLeft = 8 + depth * 12 + "px";
    row.innerHTML =
      `<span class="twist">${e.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>` +
      `<span class="ic ${e.type === "dir" ? "folder" : ""}">${e.type === "dir" ? SVG.folder : SVG.file}</span>` +
      `<span class="nm">${e.name}</span>` +
      (badge ? `<span class="badge ${badge}">${badge}</span>` : "");
    row.onclick = (ev) => { ev.stopPropagation(); e.type === "dir" ? toggleDir(e.path) : openFile(e.path); };
    container.appendChild(row);
    if (isOpen) renderLevel(container, e.path, depth + 1);
  }
}
async function toggleDir(dir) {
  if (S.expanded[dir]) delete S.expanded[dir];
  else await expandDir(dir);
  renderTree();
}

// --------------------------------------------------------------------------- tabs / editor
async function openFile(path) {
  let tab = S.tabs.find((t) => t.path === path);
  if (!tab) {
    let content = "";
    try { content = await apiText("/file?path=" + encodeURIComponent(path)); }
    catch (e) { content = "// " + e.message; }
    tab = { path, model: monaco.editor.createModel(content, langOf(path)), dirty: false };
    S.tabs.push(tab);
  }
  setActive(path);
}
function setActive(path) {
  S.active = path;
  const tab = S.tabs.find((t) => t.path === path);
  if (tab) {
    editor.setModel(tab.model);
    $("stLang").textContent = tab.model.getLanguageId();
    updateBreadcrumb(editor.getPosition() ? editor.getPosition().lineNumber : 1);
  }
  renderTabs(); renderTree(); updateWelcome();
}
function closeTab(path, ev) {
  if (ev) ev.stopPropagation();
  const i = S.tabs.findIndex((t) => t.path === path);
  if (i < 0) return;
  const tab = S.tabs[i];
  if (tab.dirty && !confirm(`Discard unsaved changes to ${path}?`)) return;
  tab.model.dispose();
  S.tabs.splice(i, 1);
  if (S.active === path) {
    const next = S.tabs[i] || S.tabs[i - 1];
    if (next) setActive(next.path);
    else { S.active = null; editor.setModel(monaco.editor.createModel("", "plaintext")); $("breadcrumb").textContent = ""; updateWelcome(); }
  }
  renderTabs();
}
function renderTabs() {
  const el = $("tabs"); el.innerHTML = "";
  for (const t of S.tabs) {
    const name = t.path.split("/").pop();
    const mod = S.git[t.path] === "M";
    const tab = document.createElement("div");
    tab.className = "tab" + (t.path === S.active ? " active" : "");
    tab.innerHTML = `<span class="ti ic">${SVG.file}</span><span>${name}</span>` +
      (mod ? `<span class="mflag">M</span>` : "") +
      (t.dirty ? `<span class="dirty"></span>` : `<span class="tx">✕</span>`);
    tab.onclick = () => setActive(t.path);
    const x = tab.querySelector(".tx");
    if (x) x.onclick = (ev) => closeTab(t.path, ev);
    el.appendChild(tab);
  }
}
function updateWelcome() { $("welcome").hidden = !!S.active; }

function enclosing(model, line) {
  for (let l = line; l >= 1 && l > line - 500; l--) {
    const t = model.getLineContent(l);
    const m = t.match(/function\s+([A-Za-z0-9_$]+)/) ||
      t.match(/def\s+([A-Za-z0-9_]+)/) ||
      t.match(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/) ||
      t.match(/^\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/);
    if (m) return m[1];
  }
  return "";
}
function updateBreadcrumb(line) {
  if (!S.active) { $("breadcrumb").textContent = ""; return; }
  const parts = S.active.split("/");
  let html = parts.map((p, i) => `<span>${p}</span>`).join('<span class="bc-sep">›</span>');
  const tab = S.tabs.find((t) => t.path === S.active);
  if (tab) {
    const fn = enclosing(tab.model, line || 1);
    if (fn) html += `<span class="bc-sep">›</span><span class="fn">ƒ ${fn}</span>`;
  }
  $("breadcrumb").innerHTML = html;
}

async function saveActive() {
  const tab = S.tabs.find((t) => t.path === S.active);
  if (!tab) return;
  try {
    await api("/file", { method: "PUT", body: JSON.stringify({ path: tab.path, content: tab.model.getValue() }) });
    tab.dirty = false; renderTabs(); await loadGit(); renderTree();
    toast("Saved " + tab.path.split("/").pop());
  } catch (e) {
    toast("Save failed: " + e.message);
  }
}
async function saveAll() {
  let failed = 0;
  for (const t of S.tabs.filter((x) => x.dirty)) {
    try {
      await api("/file", { method: "PUT", body: JSON.stringify({ path: t.path, content: t.model.getValue() }) });
      t.dirty = false;
    } catch (e) {
      console.error("Failed to save:", t.path, e);
      failed++;
    }
  }
  renderTabs(); await loadGit(); renderTree();
  if (failed > 0) toast(`Failed to save ${failed} file(s)`);
  else toast("All files saved");
}

// --------------------------------------------------------------------------- models
async function loadModels() {
  try {
    const m = await api("/models");
    const sel = $("modelSelect"); sel.innerHTML = "";
    if (!m.models.length) { sel.innerHTML = "<option>no models</option>"; return; }
    for (const mod of m.models.filter((x) => !x.is_embed)) {
      const o = document.createElement("option");
      o.value = mod.name; o.textContent = mod.name + (mod.is_cloud ? " ☁" : "");
      if (mod.name === m.active) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = async () => {
      const val = sel.value;
      await api("/models/active", { method: "POST", body: JSON.stringify({ name: val }) });
      toast("Selected model: " + val);
    };
  } catch (e) {
    console.error("Failed to load LLM models:", e);
  }
}

// --------------------------------------------------------------------------- agent
function fmt(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/```([\s\S]*?)```/g, (m, c) => `<pre>${c}</pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}
function diffHtml(diff) {
  return diff.split("\n").map((l) => {
    let c = "";
    if (l.startsWith("+") && !l.startsWith("+++")) c = "add";
    else if (l.startsWith("-") && !l.startsWith("---")) c = "del";
    else if (l.startsWith("@@")) c = "hd";
    return `<span class="${c}">${l.replace(/&/g, "&amp;").replace(/</g, "&lt;") || " "}</span>`;
  }).join("\n");
}
const AGENT = [];
function renderAgent() {
  const log = $("agentLog");
  if (!AGENT.length) {
    log.innerHTML = `<div class="agent-empty">Ask the agent to build or change code in the open folder. It reads files, proposes diffs, and applies them when you click <b>Apply</b>.</div>`;
    return;
  }
  log.innerHTML = "";
  for (const m of AGENT) {
    if (m.role === "user") {
      const d = document.createElement("div"); d.className = "msg-user"; d.textContent = m.content; log.appendChild(d);
    } else {
      const d = document.createElement("div"); d.className = "msg-assistant";
      let html = "";
      
      // Render completed steps
      if (m.steps && m.steps.length) {
        html += `<div class="steps">`;
        m.steps.forEach((s) => {
          let icon = "⚙";
          let actionLabel = s.action;
          if (s.action === "read") { icon = "🔍"; actionLabel = "Read"; }
          else if (s.action === "write") { icon = "📝"; actionLabel = "Wrote"; }
          else if (s.action === "shell") { icon = "💻"; actionLabel = "Ran"; }
          
          const statusClass = s.ok ? "step-ok" : "step-err";
          html += `<span class="step ${statusClass}">${icon} ${actionLabel}: <code>${s.path}</code></span>`;
        });
        html += `</div>`;
      }
      
      // Render active/pending status indicator
      if (m.status && m.status !== "done") {
        let statusHtml = "";
        const cleanPath = (m.pending_path || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
        if (m.status === "thinking") {
          statusHtml = `<div class="agent-status-indicator thinking"><span class="pulse-dot"></span><span class="status-text">Thinking...</span></div>`;
        } else if (m.status === "write") {
          statusHtml = `<div class="agent-status-indicator writing"><span class="spinner"></span><span class="status-text">Writing file <code>${cleanPath}</code>...</span></div>`;
        } else if (m.status === "shell") {
          statusHtml = `<div class="agent-status-indicator running"><span class="spinner"></span><span class="status-text">Running command <code>${cleanPath}</code>...</span></div>`;
        } else if (m.status === "read") {
          statusHtml = `<div class="agent-status-indicator reading"><span class="spinner"></span><span class="status-text">Reading file <code>${cleanPath}</code>...</span></div>`;
        }
        html += statusHtml;
      }
      
      if (m.content) html += fmt(m.content);
      d.innerHTML = html;
      
      (m.edits || []).forEach((e) => {
        const card = document.createElement("div"); card.className = "edit-card";
        card.innerHTML = `<div class="edit-head"><span class="path"><span class="kind ${e.kind}">${e.kind}</span>${e.path}</span>` +
          `<button ${e.applied ? "disabled" : ""}>${e.applied ? "Applied ✓" : "Apply"}</button></div><div class="diff">${diffHtml(e.diff)}</div>`;
        card.querySelector("button").onclick = async (ev) => {
          const res = await api("/agent/apply", { method: "POST", body: JSON.stringify({ edits: [{ path: e.path, new_content: e.new_content }] }) });
          if (res.applied.includes(e.path)) {
            e.applied = true; ev.target.disabled = true; ev.target.textContent = "Applied ✓";
            await loadGit(); renderTree();
            const open = S.tabs.find((t) => t.path === e.path);
            if (open) { open.model.setValue(e.new_content); open.dirty = false; renderTabs(); }
            toast("Applied " + e.path);
          } else toast("Apply failed");
        };
        d.appendChild(card);
      });
      log.appendChild(d);
    }
  }
  log.scrollTop = log.scrollHeight;
}
async function sendAgent() {
  const ta = $("agentText"); const instruction = ta.value.trim();
  if (!instruction) return;
  ta.value = "";
  AGENT.push({ role: "user", content: instruction });
  // Add a live-streaming placeholder
  const liveMsgIdx = AGENT.length;
  AGENT.push({ role: "assistant", content: "", thinking: true, status: "thinking", steps: [] });
  renderAgent();

  const history = AGENT.filter((m, i) => i < liveMsgIdx && !m.thinking).map((m) => ({ role: m.role, content: m.content }));

  try {
    const res = await fetch("/api/agent/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, history })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const liveMsg = AGENT[liveMsgIdx];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let evt;
        try { evt = JSON.parse(line.slice(6)); } catch { continue; }

        if (evt.type === "token") {
          liveMsg.content += evt.token;
          liveMsg.thinking = true;
          liveMsg.status = "thinking";
          renderAgent();
        } else if (evt.type === "status") {
          liveMsg.status = evt.status;
          renderAgent();
        } else if (evt.type === "tool_start") {
          liveMsg.status = evt.action;
          liveMsg.pending_path = evt.path || evt.command || "";
          renderAgent();
        } else if (evt.type === "step") {
          liveMsg.steps = liveMsg.steps || [];
          liveMsg.steps.push(evt.step);
          liveMsg.status = "thinking";
          liveMsg.pending_path = "";
          renderAgent();
        } else if (evt.type === "clear") {
          liveMsg.content = "";
          renderAgent();
        } else if (evt.type === "done") {
          // Replace the live placeholder with the final message
          AGENT.splice(liveMsgIdx, 1);
          AGENT.push({
            role: "assistant",
            content: evt.message || liveMsg.content,
            steps: evt.steps || liveMsg.steps,
            edits: evt.edits || []
          });
          renderAgent();
        }
      }
    }

    // Safety: if stream ended without a "done" event
    if (AGENT[liveMsgIdx] && AGENT[liveMsgIdx].thinking) {
      AGENT[liveMsgIdx].thinking = false;
      if (!AGENT[liveMsgIdx].content) AGENT[liveMsgIdx].content = "No response from model.";
      renderAgent();
    }
  } catch (e) {
    const i = AGENT.findIndex((m) => m.thinking); if (i >= 0) AGENT.splice(i, 1);
    AGENT.push({ role: "assistant", content: "Error: " + e.message });
    renderAgent();
  }
}

// --------------------------------------------------------------------------- terminal
async function runCommand(cmd) {
  const out = $("termOut");
  out.innerHTML += `<div class="cmd">› ${cmd}</div>`;
  try {
    const r = await api("/run", { method: "POST", body: JSON.stringify({ command: cmd }) });
    if (r.stdout) out.innerHTML += `<div>${r.stdout.replace(/</g, "&lt;")}</div>`;
    if (r.stderr) out.innerHTML += `<div class="err">${r.stderr.replace(/</g, "&lt;")}</div>`;
  } catch (e) { out.innerHTML += `<div class="err">${e.message}</div>`; }
  out.scrollTop = out.scrollHeight;
  await loadGit(); renderTree();
}

// --------------------------------------------------------------------------- upload folder (web + drag & drop support)
async function uploadFolder(filesArray) {
  const files = Array.from(filesArray || []);
  if (!files.length) return;
  const SKIP = /(^|\/)(node_modules|\.git|\.next|dist|build|out|__pycache__|\.venv|venv|\.gradle|target|\.idea|\.cache)(\/|$)/;
  let keep = files.filter((f) => {
    const path = f.webkitRelativePath || f.relativePath || f.name;
    return !SKIP.test(path) && f.size <= 2000000;
  });
  if (!keep.length) { toast("No uploadable files found."); return; }
  keep = keep.slice(0, 4000);
  const firstPath = keep[0].webkitRelativePath || keep[0].relativePath || keep[0].name;
  const top = firstPath.split("/")[0] || "workspace";
  
  toast(`Uploading ${keep.length} files…`, 60000);
  const fd = new FormData();
  keep.forEach((f) => fd.append("files", f, f.name));
  
  const relativePaths = keep.map((f) => f.webkitRelativePath || f.relativePath || f.name);
  fd.append("paths", JSON.stringify(relativePaths));
  fd.append("name", top);
  
  try {
    const res = await rfetch("/api/upload", { method: "POST", body: fd }, 2);
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    S.tabs.forEach((t) => t.model.dispose()); S.tabs = []; S.active = null; renderTabs();
    editor.setModel(monaco.editor.createModel("", "plaintext"));
    await refreshRoot();
    toast(`Opened ${j.name} — ${j.files} files`);
  } catch (e) {
    toast("Upload failed: " + e.message);
  }
}

// Recursively resolve all files in dropped directory entry
async function getFilesFromEntry(entry, path = "") {
  let files = [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    file.relativePath = path + entry.name;
    files.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await new Promise((resolve) => {
      let allEntries = [];
      function readAll() {
        reader.readEntries((results) => {
          if (results.length) {
            allEntries = allEntries.concat(results);
            readAll();
          } else {
            resolve(allEntries);
          }
        }, () => resolve(allEntries));
      }
      readAll();
    });
    for (const child of entries) {
      const childFiles = await getFilesFromEntry(child, path + entry.name + "/");
      files = files.concat(childFiles);
    }
  }
  return files;
}

// --------------------------------------------------------------------------- menus
const MENUS = {
  File: [["Open Folder…", "", openFolderModal], ["Upload Folder…", "", () => $("folderUpload").click()], ["New File…", "", newFile],
    ["sep"], ["Save", "Ctrl+S", saveActive], ["Save All", "", saveAll]],
  View: [["Toggle Explorer", "", () => togglePanel("explorer")], ["Toggle Agent", "", () => togglePanel("agent")], ["Toggle Terminal", "Ctrl+`", () => togglePanel("terminal")]],
  Run: [["Open Terminal", "", () => togglePanel("terminal", true)]],
  Terminal: [["New Terminal", "Ctrl+`", () => togglePanel("terminal", true)]],
  Go: [["Go to Line…", "Ctrl+G", () => editor && editor.getAction("editor.action.gotoLine").run()], ["Go to Symbol…", "", () => editor && editor.getAction("editor.action.quickOutline").run()]],
  Edit: [["Find", "Ctrl+F", () => editor && editor.getAction("actions.find").run()], ["Replace", "Ctrl+H", () => editor && editor.getAction("editor.action.startFindReplaceAction").run()]],
  Selection: [["Select All", "Ctrl+A", () => editor && editor.setSelection(editor.getModel().getFullModelRange())]],
  Help: [["About", "", () => toast("Source Code IDE — a standalone coding IDE with an AI agent, powered by Ollama.")]],
};
function openDropdown(menuEl) {
  const items = MENUS[menuEl.dataset.menu]; const dd = $("dropdown");
  if (!items) { dd.hidden = true; return; }
  document.querySelectorAll(".menu").forEach((m) => m.classList.remove("open"));
  menuEl.classList.add("open"); dd.innerHTML = "";
  for (const it of items) {
    if (it[0] === "sep") { const s = document.createElement("div"); s.className = "dd-sep"; dd.appendChild(s); continue; }
    const d = document.createElement("div"); d.className = "dd-item";
    d.innerHTML = `<span>${it[0]}</span><span class="key">${it[1] || ""}</span>`;
    d.onclick = () => { dd.hidden = true; menuEl.classList.remove("open"); it[2](); };
    dd.appendChild(d);
  }
  const r = menuEl.getBoundingClientRect(); dd.style.left = r.left + "px"; dd.style.top = r.bottom + "px"; dd.hidden = false;
}

// --------------------------------------------------------------------------- panels
function togglePanel(which, forceOn) {
  if (which === "terminal") { const t = $("terminal"); t.hidden = forceOn ? false : !t.hidden; return; }
  const el = which === "explorer" ? $("explorerPanel") : $("agentPanel");
  const show = forceOn ? true : el.style.display === "none";
  el.style.display = show ? "flex" : "none";
  
  const activeBtn = document.querySelector(`.act[data-toggle="${which}"]`);
  if (activeBtn) activeBtn.classList.toggle("active", show);
  
  document.querySelector(".body").style.gridTemplateColumns =
    ($("agentPanel").style.display === "none" ? "0" : "320px") + " 1fr " +
    ($("explorerPanel").style.display === "none" ? "0" : "260px") + " 48px";
}

// --------------------------------------------------------------------------- open-folder modal (native OS dialog + fallback)
let folderCwd = "";
async function openFolderModal() {
  try {
    const res = await api("/select-folder", { method: "POST" });
    if (res && res.ok) {
      S.tabs.forEach((t) => t.model.dispose()); S.tabs = []; S.active = null; renderTabs();
      editor.setModel(monaco.editor.createModel("", "plaintext"));
      await refreshRoot();
      toast("Opened " + res.name);
      return;
    }
  } catch (e) {
    console.warn("Native folder selection not available, falling back:", e);
  }
  $("folderModal").hidden = false;
  await loadDirs(S.root);
}
async function loadDirs(path) {
  try {
    const r = await api("/dirs?path=" + encodeURIComponent(path || ""));
    folderCwd = r.path;
    $("folderPath").textContent = r.path || "This PC";
    const list = $("folderList"); list.innerHTML = "";
    for (const d of r.dirs) {
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="ic folder">${SVG.folder}</span><span class="nm">${d.name}</span>`;
      row.onclick = () => loadDirs(d.path); list.appendChild(row);
    }
    $("folderUp").onclick = () => loadDirs(r.parent || "");
  } catch (e) {
    console.error("Failed to load directories:", e);
    toast("Failed to list folder: " + e.message);
  }
}
async function chooseFolder() {
  if (!folderCwd) return;
  await api("/root", { method: "POST", body: JSON.stringify({ path: folderCwd }) });
  $("folderModal").hidden = true;
  S.tabs.forEach((t) => t.model.dispose()); S.tabs = []; S.active = null; renderTabs();
  editor.setModel(monaco.editor.createModel("", "plaintext"));
  await refreshRoot();
}
async function newFile() {
  const name = prompt("New file path (relative to the open folder):");
  if (!name) return;
  try {
    await api("/create", { method: "POST", body: JSON.stringify({ path: name, kind: "file" }) });
    await expandDir(""); renderTree(); openFile(name);
  } catch (e) {
    toast("Create failed: " + e.message);
  }
}

// --------------------------------------------------------------------------- wire up
document.addEventListener("DOMContentLoaded", () => {
  $("menus").querySelectorAll(".menu").forEach((m) => {
    m.onclick = (e) => { e.stopPropagation(); openDropdown(m); };
    m.onmouseenter = () => { if (document.querySelector(".menu.open")) openDropdown(m); };
  });
  document.addEventListener("click", () => { $("dropdown").hidden = true; document.querySelectorAll(".menu").forEach((m) => m.classList.remove("open")); });

  $("agentSend").onclick = sendAgent;
  $("agentText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAgent(); } });
  $("agentNew").onclick = () => { AGENT.length = 0; renderAgent(); };

  $("refreshBtn").onclick = async () => { await loadGit(); await expandDir(""); renderTree(); };
  $("newFileBtn").onclick = newFile;
  $("uploadAct").onclick = () => $("folderUpload").click();
  $("welcomeUpload").onclick = () => $("folderUpload").click();
  $("welcomeOpen").onclick = openFolderModal;
  $("folderUpload").addEventListener("change", (e) => { const fl = e.target.files; e.target.value = ""; uploadFolder(fl); });

  $("scAct").onclick = async () => { await loadGit(); renderTree(); const n = $("scBadge").textContent; toast(n === "0" || $("scBadge").hidden ? "No changes" : n + " changed file(s)"); };
  $("settingsAct").onclick = $("tbSettings").onclick = () => { togglePanel("agent", true); $("modelSelect").focus(); toast("Model selection is in the Agent panel."); };
  $("termClose").onclick = () => ($("terminal").hidden = true);
  $("termCmd").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.value.trim()) { const c = e.target.value; e.target.value = ""; runCommand(c); } });

  $("folderCancel").onclick = () => ($("folderModal").hidden = true);
  $("folderOpen").onclick = chooseFolder;

  document.querySelectorAll(".act[data-toggle]").forEach((b) => {
    b.onclick = () => { togglePanel(b.dataset.toggle); };
  });
  document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "`") { e.preventDefault(); togglePanel("terminal"); } });

  // Drag and Drop folder upload
  const dragOverlay = document.createElement("div");
  dragOverlay.className = "drag-overlay";
  dragOverlay.hidden = true;
  dragOverlay.innerHTML = `<div class="drag-overlay-card"><h2>Drop to Open Folder</h2><p>Files will be loaded into the workspace</p></div>`;
  document.body.appendChild(dragOverlay);

  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragOverlay.hidden = false;
  });
  dragOverlay.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  dragOverlay.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (e.relatedTarget === null || e.relatedTarget === document.body) {
      dragOverlay.hidden = true;
    }
  });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragOverlay.hidden = true;
    
    const items = e.dataTransfer.items;
    if (!items || !items.length) return;
    
    let allFiles = [];
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        const files = await getFilesFromEntry(entry);
        allFiles = allFiles.concat(files);
      }
    }
    if (allFiles.length > 0) {
      await uploadFolder(allFiles);
    }
  });

  renderAgent();
});
