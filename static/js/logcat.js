// logcat.js — Panel logcat: stream, lọc (cấp độ/tag/text), highlight, xuất file, resize.

import { $, LS, wsProto } from "./core.js";
import { t } from "./i18n.js";

const LOG_MAX = 5000;                 // số dòng tối đa giữ trong bộ nhớ
const LOG_MIN_W = 280;

let logWs = null;
let logLines = [];                    // {lvl, tag, raw}
let logPartial = "";                  // phần dòng chưa trọn
let logLevels = { V: true, D: true, I: true, W: true, E: true };

function lvlColor(lvl) {
  return lvl === "E" ? "text-red-400" : lvl === "W" ? "text-yellow-300"
       : lvl === "I" ? "text-green-300" : lvl === "D" ? "text-sky-300" : "text-slate-400";
}
function refreshLvlButtons() {
  document.querySelectorAll(".lvlbtn").forEach((b) => {
    const on = logLevels[b.dataset.lvl];
    b.classList.toggle("bg-blue-600", on);
    b.classList.toggle("text-white", on);
    b.classList.toggle("border-blue-600", on);
    b.classList.toggle("text-slate-700", !on);
  });
}

// "01-02 03:04:05.678  1234  5678 I Tag: message" -> {lvl, tag}
function parseLine(raw) {
  const m = raw.match(/^\d\d-\d\d\s+[\d:.]+\s+\d+\s+\d+\s+([VDIWEAF])\s+([^:]*?)\s*:/);
  if (m) return { lvl: m[1], tag: m[2].trim(), raw };
  return { lvl: "", tag: "", raw };
}

function passFilter(item) {
  if (item.lvl && logLevels.hasOwnProperty(item.lvl) && !logLevels[item.lvl]) return false;
  const tags = $("logTag").value.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (tags.length) {
    const t = item.tag.toLowerCase();
    if (!tags.some((f) => t.includes(f))) return false;
  }
  const txtF = $("logText").value.trim().toLowerCase();
  if (txtF && !item.raw.toLowerCase().includes(txtF)) return false;
  return true;
}

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function renderLog() {
  const hi = $("logHi").value.trim();
  const view = $("logView");
  const autoscroll = $("logAutoscroll").checked;
  const prevTop = view.scrollTop;
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 12;
  const shown = logLines.filter(passFilter);
  let html = "";
  for (const it of shown) {
    let line = esc(it.raw);
    if (hi) {
      try {
        const re = new RegExp("(" + hi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
        line = line.replace(re, '<mark class="bg-yellow-300 text-black">$1</mark>');
      } catch (_) {}
    }
    html += `<div class="${lvlColor(it.lvl)}">${line}</div>`;
  }
  view.innerHTML = html;
  $("logShown").textContent = shown.length;
  $("logTotal").textContent = logLines.length;
  if (autoscroll && atBottom) view.scrollTop = view.scrollHeight;
  else view.scrollTop = prevTop;
}

function addLogChunk(text) {
  logPartial += text;
  const parts = logPartial.split("\n");
  logPartial = parts.pop();
  for (const ln of parts) {
    if (ln === "") continue;
    logLines.push(parseLine(ln.replace(/\r$/, "")));
  }
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  renderLog();
}

function setLogState(label, running) {
  $("logState").textContent = label;
  $("logStart").disabled = running;
  $("logStop").disabled = !running;
}

function logStart() {
  const token = $("token").value.trim();
  if (!token) { alert(t("logcat.enterTokenFirst")); return; }
  if (logWs) { logWs.onclose = null; logWs.close(); logWs = null; }
  const serial = $("devices").value;
  const url = `${wsProto()}://${location.host}/logcat?token=${encodeURIComponent(token)}&serial=${encodeURIComponent(serial)}`;
  setLogState(t("logcat.connecting"), true);
  logWs = new WebSocket(url); logWs.binaryType = "arraybuffer";
  logWs.onopen = () => setLogState(t("logcat.streaming"), true);
  logWs.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) addLogChunk(new TextDecoder().decode(ev.data));
    else addLogChunk(String(ev.data));
  };
  logWs.onclose = () => { logWs = null; setLogState(t("logcat.stopped"), false); };
  logWs.onerror = () => setLogState(t("logcat.error"), false);
}
function logStop() {
  if (logWs) { logWs.onclose = null; logWs.close(); logWs = null; }
  setLogState(t("logcat.stopped"), false);
}

function downloadLog() {
  const shown = logLines.filter(passFilter).map((i) => i.raw).join("\n");
  const blob = new Blob([shown], { type: "text/plain" });
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = URL.createObjectURL(blob);
  a.download = `logcat-${ts}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Resize panel bằng cách kéo handle bên trái ---
function clampLogWidth(px) {
  const max = Math.round(window.innerWidth * 0.8);
  return Math.max(LOG_MIN_W, Math.min(px, max));
}
function applyLogWidth(px) { $("logcatPanel").style.width = clampLogWidth(px) + "px"; }

function setupResize() {
  const handle = $("logResize");
  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const right = $("logcatPanel").getBoundingClientRect().right;
    applyLogWidth(right - e.clientX);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    LS.set("logWidth", parseInt($("logcatPanel").style.width, 10) || 544);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  window.addEventListener("resize", () => applyLogWidth(parseInt($("logcatPanel").style.width, 10) || 544));
}

export function initLogcat() {
  // khôi phục bộ lọc cấp độ + bề rộng đã lưu
  try { Object.assign(logLevels, JSON.parse(LS.get("logLevels", "") || "{}")); } catch (_) {}
  applyLogWidth(parseInt(LS.get("logWidth", "544"), 10) || 544);
  setupResize();

  $("toggleLogcat").onclick = () => {
    const p = $("logcatPanel");
    p.classList.toggle("hidden");
    if (!p.classList.contains("hidden")) { refreshLvlButtons(); if (!logWs) logStart(); }
  };
  $("logStart").onclick = logStart;
  $("logStop").onclick = logStop;
  $("logClear").onclick = () => {
    logLines = []; logPartial = "";
    if (logWs) logWs.send(JSON.stringify({ type: "clear" }));
    renderLog();
  };
  $("logDownload").onclick = downloadLog;
  $("logToBottom").onclick = () => {
    const view = $("logView");
    view.scrollTop = view.scrollHeight;
    $("logAutoscroll").checked = true;
  };
  $("logTag").oninput = renderLog;
  $("logText").oninput = renderLog;
  $("logHi").oninput = renderLog;
  document.querySelectorAll(".lvlbtn").forEach((b) => {
    b.onclick = () => {
      logLevels[b.dataset.lvl] = !logLevels[b.dataset.lvl];
      LS.set("logLevels", JSON.stringify(logLevels));
      refreshLvlButtons(); renderLog();
    };
  });
  refreshLvlButtons();
}
