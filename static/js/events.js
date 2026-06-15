// events.js — Kênh thông báo chung (WS /events): biết script nào đang chạy,
// hiện toast khi người khác chạy / script kết thúc, tránh chạy trùng.

import { $, LS, wsProto } from "./core.js";

let evWs = null;
let reconnectTimer = null;
const running = new Map();        // id -> {id, path, label, who, started}
const changeCbs = [];            // callback khi danh sách đang-chạy thay đổi

// Tên máy hiện tại (để biết "ai" chạy). Tạo ngẫu nhiên nếu chưa đặt.
export function clientName() {
  let n = LS.get("clientName", "");
  if (!n) { n = "PC-" + Math.random().toString(36).slice(2, 6); LS.set("clientName", n); }
  return n;
}

export function getRunning() { return running; }
export function findRunningByPath(path) {
  for (const v of running.values()) if (v.path === path) return v;
  return null;
}
export function onRunningChange(cb) { changeCbs.push(cb); }
function emitChange() { for (const cb of changeCbs) { try { cb(running); } catch (_) {} } }

// ---------- Toast ----------
function toast(msg, kind) {
  const box = $("toasts");
  if (!box) return;
  const el = document.createElement("div");
  const color = kind === "ok" ? "bg-green-600" : kind === "warn" ? "bg-amber-600"
              : kind === "err" ? "bg-red-600" : "bg-slate-800";
  el.className = `${color} text-white text-xs rounded-lg px-3 py-2 shadow-lg max-w-xs break-words
                 opacity-0 transition-opacity duration-200`;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = "1"; });
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 5000);
}

// ---------- Xử lý message ----------
function handle(msg) {
  if (msg.type === "snapshot") {
    running.clear();
    for (const r of msg.running) running.set(r.id, r);
    emitChange();
  } else if (msg.type === "started") {
    running.set(msg.id, msg);
    emitChange();
    if (msg.who !== clientName()) toast(`▶ "${msg.label}" started by ${msg.who}`, "info");
  } else if (msg.type === "finished") {
    running.delete(msg.id);
    emitChange();
    const by = msg.who !== clientName() ? ` by ${msg.who}` : "";
    toast(`■ "${msg.label}" finished${by} — exit ${msg.code}`, msg.code === 0 ? "ok" : "warn");
  }
}

// ---------- Kết nối (tự nối lại) ----------
function connect() {
  const token = $("token").value.trim();
  if (!token) { scheduleReconnect(); return; }   // chưa có token -> chờ
  if (evWs) { evWs.onclose = null; evWs.close(); }
  evWs = new WebSocket(`${wsProto()}://${location.host}/events?token=${encodeURIComponent(token)}`);
  evWs.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (_) {} };
  evWs.onclose = () => { evWs = null; scheduleReconnect(); };
  evWs.onerror = () => {};
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

export function initEvents() { connect(); }
