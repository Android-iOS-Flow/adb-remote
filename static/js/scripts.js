// scripts.js — Popup chạy .bat: stream log + gửi stdin + cảnh báo chạy trùng.

import { $, wsProto } from "./core.js";
import { t } from "./i18n.js";
import { clientName, findRunningByPath, onRunningChange, getRunning } from "./events.js";

let runWs = null;
let selectedScript = null;     // đường dẫn tuyệt đối của .bat đang chọn
let lastItems = [];            // danh sách script lần tải gần nhất (để re-render dấu đang chạy)

function termWrite(text) {
  const t = $("term");
  const atBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 8;
  t.textContent += text;
  if (atBottom) t.scrollTop = t.scrollHeight;
}
function setRunState(label, running) {
  $("runState").textContent = label;
  $("stopBtn").disabled = !running;
  $("stdinBox").disabled = !running;
  $("sendStdin").disabled = !running;
  $("runBtn").disabled = running || !selectedScript;
}

async function loadScripts() {
  const token = $("token").value.trim();
  if (!token) { alert(t("conn.enterTokenFirst")); return; }
  try {
    const res = await fetch(`/api/scripts?token=${encodeURIComponent(token)}`);
    if (!res.ok) { alert(t("conn.wrongToken")); return; }
    const data = await res.json();
    $("scriptDir").textContent = data.manifest ? t("scripts.manifest", { path: data.manifest }) : "";
    lastItems = data.items || [];
    renderList();
  } catch (e) { alert(t("scripts.loadFailed", { err: e })); }
}

// Vẽ danh sách script, kèm dấu "đang chạy (bởi ai)".
function renderList() {
  const ul = $("scriptList");
  if (!ul) return;
  ul.innerHTML = "";
  if (lastItems.length === 0) {
    ul.innerHTML = `<li class="text-xs text-slate-400 px-2 py-1">${t("scripts.noScripts")}</li>`;
    return;
  }
  for (const it of lastItems) {
    const li = document.createElement("li");
    const miss = it.missing;
    const run = findRunningByPath(it.path);
    li.className = "px-2 py-1.5 rounded-lg truncate font-mono text-[13px] flex items-center gap-1 " +
                   (miss ? "text-slate-300 cursor-not-allowed" : "cursor-pointer hover:bg-slate-100");
    if (it.path === selectedScript) li.classList.add("bg-blue-100", "text-blue-700");
    const name = document.createElement("span");
    name.className = "truncate flex-1";
    name.textContent = it.label + (miss ? "  " + t("scripts.missing") : "");
    li.appendChild(name);
    if (run) {
      const badge = document.createElement("span");
      badge.className = "shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700";
      badge.textContent = "▶ " + run.who;
      li.appendChild(badge);
    }
    li.title = it.path;
    if (!miss) {
      li.onclick = () => {
        selectedScript = it.path;
        $("runFile").textContent = it.label;
        $("runFile").title = it.path;
        if (!runWs) $("runBtn").disabled = false;
        renderList();
      };
    }
    ul.appendChild(li);
  }
}

// Cập nhật badge số script đang chạy trên nút Scripts + dòng "Running now".
function renderRunning() {
  const r = getRunning();
  const badge = $("scriptsBadge");
  if (badge) {
    badge.textContent = r.size;
    badge.classList.toggle("hidden", r.size === 0);
  }
  const now = $("runningNow");
  if (now) {
    now.textContent = r.size
      ? t("scripts.runningNow", { list: [...r.values()].map((v) => `${v.label} (${v.who})`).join(", ") })
      : "";
  }
  if (!$("scriptsModal").classList.contains("hidden")) renderList();   // cập nhật dấu trong list
}

function runScript() {
  if (!selectedScript) return;
  // Cảnh báo nếu script này đang được người khác (hoặc chính bạn) chạy.
  const r = findRunningByPath(selectedScript);
  if (r && !confirm(t("scripts.alreadyRunning", { label: r.label, who: r.who }))) return;
  const token = $("token").value.trim();
  if (runWs) { runWs.onclose = null; runWs.close(); runWs = null; }
  const url = `${wsProto()}://${location.host}/run?token=${encodeURIComponent(token)}` +
              `&path=${encodeURIComponent(selectedScript)}&who=${encodeURIComponent(clientName())}`;
  termWrite(t("scripts.runHeader", { path: selectedScript }));
  setRunState(t("scripts.running"), true);
  $("runBtn").disabled = true;

  runWs = new WebSocket(url);
  runWs.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "out") termWrite(msg.data);
    else if (msg.type === "exit") {
      termWrite(t("scripts.exitedLine", { code: msg.code }));
      const w = runWs; runWs = null;
      if (w) { w.onclose = null; try { w.close(); } catch (_) {} }
      setRunState(t("scripts.exited", { code: msg.code }), false);
    }
    else if (msg.type === "error") termWrite(t("scripts.errorLine", { message: msg.message }));
    else if (msg.type === "started") { /* noop */ }
  };
  runWs.onclose = () => { runWs = null; setRunState(t("scripts.idle"), false); };
  runWs.onerror = () => termWrite(t("scripts.connError"));
}

function stopScript() { if (runWs) runWs.send(JSON.stringify({ type: "kill" })); }
function sendStdin() {
  const box = $("stdinBox");
  if (!runWs || !box.value) return;
  termWrite(box.value + "\n");
  runWs.send(JSON.stringify({ type: "stdin", data: box.value }));
  box.value = "";
}

export function initScripts() {
  $("openScripts").onclick = () => { $("scriptsModal").classList.remove("hidden"); loadScripts(); };
  $("closeScripts").onclick = () => {
    $("scriptsModal").classList.add("hidden");
    if (runWs) runWs.send(JSON.stringify({ type: "kill" }));
  };
  $("refreshScripts").onclick = loadScripts;
  $("runBtn").onclick = runScript;
  $("stopBtn").onclick = stopScript;
  $("sendStdin").onclick = sendStdin;
  $("clearTerm").onclick = () => { $("term").textContent = ""; };
  $("stdinBox").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); sendStdin(); }
  });
  // Cập nhật badge / dấu đang chạy mỗi khi hub báo thay đổi.
  onRunningChange(renderRunning);
  renderRunning();
}
