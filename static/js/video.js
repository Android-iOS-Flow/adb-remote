// video.js — Kết nối video (WebSocket), thống kê, và TỰ KẾT NỐI LẠI khi mất thiết bị.

import { $, wsProto } from "./core.js";
import { H264Decoder } from "./decoder.js";
import { loadDevices } from "./devices.js";
import { saveSettings } from "./settings.js";

const canvas = $("screen");
const ctx = canvas.getContext("2d");

let ws = null;
let connected = false;
let manualClose = false;               // true khi người dùng chủ động ngắt
let device = { width: 1080, height: 1920 };

// thống kê
let framesThisSec = 0, bytesThisSec = 0, lastRtt = null, everFrame = false, noVideoSecs = 0;

// auto-reconnect
let reconnectTimer = null;
let reconnectDelay = 1000;             // backoff: 1s -> tối đa 8s
const RECONNECT_MAX = 8000;

const decoder = new H264Decoder(canvas, () => {
  framesThisSec++;
  everFrame = true;
  showOverlay(false);
});

// ---------- UI helpers (nội bộ) ----------
function setStatus(text, kind) {
  $("statusText").textContent = text;
  $("dot").className = "w-2 h-2 rounded-full " +
    (kind === "on" ? "bg-green-500 animate-pulse" : kind === "err" ? "bg-red-500" : "bg-slate-400");
}
function showOverlay(show, text) {
  $("overlay").style.display = show ? "grid" : "none";
  if (text) $("overlay").textContent = text;
}
function clearScreen() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function setConnectBtn(isConn) {
  const b = $("connect");
  b.textContent = isConn ? "Disconnect" : "Connect";
  b.className = "w-full text-sm font-medium px-3 py-2 rounded-lg transition " +
    (isConn ? "bg-slate-200 text-slate-700 hover:bg-slate-300" : "bg-blue-600 text-white hover:bg-blue-700");
}

// ---------- API cho module khác ----------
export function isConnected() { return connected; }
export function getDevice() { return device; }
export function sendInput(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Auto-reconnect ----------
function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}
function scheduleReconnect() {
  if (manualClose || reconnectTimer) return;
  setStatus("Reconnecting…", "");
  showOverlay(true, "Device disconnected — scanning & reconnecting…");
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (manualClose) return;
    const list = await loadDevices(true);     // quét lại danh sách thiết bị
    if (manualClose) return;
    if (!list || list.length === 0) {
      reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX);
      scheduleReconnect();                    // chưa có thiết bị -> chờ tiếp
      return;
    }
    connect();                                // có thiết bị -> kết nối lại
  }, reconnectDelay);
}

// ---------- Connect / Disconnect ----------
export function connect() {
  const token = $("token").value.trim();
  if (!token) { alert("Enter token first."); return; }
  saveSettings();
  manualClose = false;
  clearReconnect();
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  decoder.reset();
  everFrame = false; noVideoSecs = 0;

  const serial  = $("devices").value;
  const engine  = $("engine").value;
  const ver     = $("scrcpyVer").value.trim() || "2.4";
  const maxsize = parseInt($("maxsize").value, 10) || 0;
  const rateBps = (parseInt($("bitrate").value, 10) || 8) * 1000000;
  const fps     = parseInt($("fps").value, 10) || 0;
  const url = `${wsProto()}://${location.host}/ws?token=${encodeURIComponent(token)}` +
              `&serial=${encodeURIComponent(serial)}&engine=${engine}` +
              `&bitrate=${rateBps}&maxsize=${maxsize}&fps=${fps}` +
              `&scrcpy_version=${encodeURIComponent(ver)}`;

  showOverlay(true, "Connecting…"); setStatus("Connecting…", "");
  ws = new WebSocket(url); ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    connected = true; manualClose = false; reconnectDelay = 1000;
    setConnectBtn(true); setStatus("Streaming", "on");
    $("stats").classList.remove("hidden");
  };
  ws.onclose = (e) => {
    connected = false; setConnectBtn(false);
    decoder.reset(); clearScreen();
    $("stats").classList.add("hidden");
    if (e.code === 4401) { setStatus("Invalid token", "err"); showOverlay(true, "Invalid token"); return; }
    if (manualClose) { setStatus("Not connected", ""); showOverlay(true, "Disconnected"); return; }
    scheduleReconnect();                       // mất kết nối ngoài ý muốn -> tự nối lại
  };
  ws.onerror = () => setStatus("Connection error", "err");
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "meta") { device.width = msg.width; device.height = msg.height; }
      else if (msg.type === "pong") { lastRtt = Math.round(performance.now() - msg.t); }
      else if (msg.type === "info") { showOverlay(true, msg.message); }
      else if (msg.type === "error") { setStatus("Error", "err"); showOverlay(true, msg.message); }
      return;
    }
    bytesThisSec += ev.data.byteLength;
    decoder.feed(ev.data);
  };
}

export function disconnect() {
  manualClose = true;
  clearReconnect(); reconnectDelay = 1000;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  connected = false; decoder.reset();
  setConnectBtn(false); setStatus("Not connected", "");
  clearScreen();
  showOverlay(true, "Disconnected"); $("stats").classList.add("hidden");
}

// ---------- Vòng thống kê + watchdog (mỗi giây) ----------
function startStatsLoop() {
  setInterval(() => {
    if (connected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
    }
    $("fpsVal").textContent = framesThisSec;
    $("mbpsVal").textContent = (bytesThisSec * 8 / 1e6).toFixed(1);
    if (lastRtt !== null) {
      const el = $("pingVal");
      el.textContent = lastRtt;
      el.className = lastRtt < 80 ? "text-green-400" : lastRtt < 200 ? "text-yellow-400" : "text-red-400";
    }
    if (connected && !everFrame) {
      noVideoSecs++;
      if (noVideoSecs >= 5 && $("overlay").style.display !== "none") {
        const eng = $("engine").value;
        showOverlay(true, eng === "scrcpy"
          ? "Connected but no video yet. Check the server console log (scrcpy), verify the version, or switch Engine to screenrecord."
          : "Connected but no video yet. Check the server console log and that the device screen is on.");
      }
    } else {
      noVideoSecs = 0;
    }
    framesThisSec = 0; bytesThisSec = 0;
  }, 1000);
}

export function initVideo() {
  $("refresh").onclick = () => loadDevices(false);
  $("connect").onclick = () => (connected ? disconnect() : connect());
  showOverlay(true, "Enter token and click Connect");
  startStatsLoop();
}
