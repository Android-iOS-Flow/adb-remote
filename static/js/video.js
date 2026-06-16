// video.js — Kết nối video (WebSocket), thống kê, và TỰ KẾT NỐI LẠI khi mất thiết bị.

import { $, wsProto } from "./core.js";
import { t } from "./i18n.js";
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
let staleSecs = 0;                  // số giây liên tiếp không có khung hình mới (phát hiện đứng hình)
let lastClients = null;            // số client đang kết nối (từ server qua pong)

const STALE_LIMIT = 4;             // quá ngần này giây không có frame -> coi như mất thiết bị

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
// Lưu khoá i18n hiện tại để render lại khi đổi ngôn ngữ.
let lastStatusKey = "status.notConnected", lastStatusKind = "";
let lastOverlayShow = true, lastOverlayKey = "overlay.enterToken", lastOverlayParams = null, lastOverlayRaw = null;

function setStatus(key, kind) {
  lastStatusKey = key; lastStatusKind = kind;
  $("statusText").textContent = t(key);
  $("dot").className = "w-2 h-2 rounded-full " +
    (kind === "on" ? "bg-green-500 animate-pulse" : kind === "err" ? "bg-red-500" : "bg-slate-400");
}
// show: bật/tắt overlay. key: khoá i18n (kèm params). raw: chuỗi đã dịch sẵn (ưu tiên hơn key).
function showOverlay(show, key, params, raw) {
  lastOverlayShow = show;
  if (key !== undefined) { lastOverlayKey = key; lastOverlayParams = params || null; lastOverlayRaw = raw || null; }
  $("overlay").style.display = show ? "grid" : "none";
  const text = lastOverlayRaw != null ? lastOverlayRaw : (lastOverlayKey ? t(lastOverlayKey, lastOverlayParams) : "");
  if (text) $("overlay").textContent = text;
}

// Gọi khi đổi ngôn ngữ: render lại status + overlay theo khoá đã lưu.
export function refreshOverlayText() {
  $("statusText").textContent = t(lastStatusKey);
  if (lastOverlayRaw != null) return;   // chuỗi raw (vd trạng thái thiết bị) tự cập nhật ở lần probe sau
  const text = lastOverlayKey ? t(lastOverlayKey, lastOverlayParams) : "";
  if (text) $("overlay").textContent = text;
}

function clearScreen() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
function setConnectBtn(isConn) {
  const b = $("connect");
  b.textContent = isConn ? t("conn.disconnect") : t("conn.connect");
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
  setStatus("status.reconnecting", "");
  showOverlay(true, "overlay.reconnecting");
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
  if (!token) { alert(t("conn.enterTokenFirst")); return; }
  saveSettings();
  manualClose = false;
  clearReconnect();
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  decoder.reset();
  everFrame = false; noVideoSecs = 0; staleSecs = 0; checkingStall = false;

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

  showOverlay(true, "overlay.connecting"); setStatus("status.connecting", "");
  ws = new WebSocket(url); ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    connected = true; manualClose = false; reconnectDelay = 1000;
    setConnectBtn(true); setStatus("status.streaming", "on");
    $("stats").classList.remove("hidden");
  };
  ws.onclose = (e) => {
    connected = false; setConnectBtn(false);
    decoder.reset(); clearScreen();
    $("stats").classList.add("hidden");
    if (e.code === 4401) { setStatus("status.invalidToken", "err"); showOverlay(true, "overlay.invalidToken"); return; }
    if (manualClose) { setStatus("status.notConnected", ""); showOverlay(true, "overlay.disconnected"); return; }
    scheduleReconnect();                       // mất kết nối ngoài ý muốn -> tự nối lại
  };
  ws.onerror = () => setStatus("status.connectionError", "err");
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.type === "meta") { device.width = msg.width; device.height = msg.height; }
      else if (msg.type === "pong") {
        lastRtt = Math.round(performance.now() - msg.t);
        if (typeof msg.clients === "number") {
          lastClients = msg.clients;
          $("clientsVal").textContent = lastClients;
        }
      }
      else if (msg.type === "info") { showOverlay(true, null, null, msg.message); }
      else if (msg.type === "error") { setStatus("status.error", "err"); showOverlay(true, null, null, msg.message); }
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
  setConnectBtn(false); setStatus("status.notConnected", "");
  clearScreen();
  showOverlay(true, "overlay.disconnected"); $("stats").classList.add("hidden");
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
        explainNoVideo();
      }
    } else {
      noVideoSecs = 0;
    }

    // Phát hiện MẤT THIẾT BỊ vs MÀN HÌNH TĨNH.
    // Tín hiệu sống = BYTE nhận từ socket (không phải frame đã giải mã): màn hình
    // đứng yên vẫn là kết nối tốt nhưng không có frame mới -> KHÔNG được reconnect.
    // Khi không có byte nào trong một lúc, ta HỎI server trạng thái thiết bị để
    // phân biệt: thiết bị còn đó (tĩnh) thì giữ nguyên, mất rồi thì mới nối lại.
    if (connected && everFrame) {
      if (bytesThisSec === 0) {
        staleSecs++;
        if (staleSecs >= STALE_LIMIT && !checkingStall) {
          checkStallReason();         // probe: chỉ reconnect nếu thiết bị thật sự mất
        }
      } else {
        staleSecs = 0;
        if ($("overlay").style.display !== "none") showOverlay(false);
        setStatus("status.streaming", "on");
      }
    } else {
      staleSecs = 0;
    }

    framesThisSec = 0; bytesThisSec = 0;
  }, 1000);
}

// Khi luồng video ngừng gửi byte: hỏi server xem thiết bị còn kết nối không.
//  - còn (ready/booting): chỉ là màn hình tĩnh -> giữ kết nối, không nối lại.
//  - mất (no_device/offline/unauthorized): coi như rớt -> ngắt & tự nối lại.
let checkingStall = false;
async function checkStallReason() {
  if (checkingStall) return;
  checkingStall = true;
  try {
    const token  = $("token").value.trim();
    const serial = $("devices").value;
    const res = await fetch(`/api/device-status?token=${encodeURIComponent(token)}` +
                            `&serial=${encodeURIComponent(serial)}`);
    if (!connected) return;
    if (!res.ok) return;              // không chắc -> cứ giữ kết nối, thử lại giây sau
    const st = await res.json();
    if (!connected) return;
    if (st.state === "ready" || st.state === "booting") {
      // Thiết bị vẫn còn: đây là màn hình tĩnh, không có khung hình mới.
      staleSecs = 0;                  // reset để không dồn probe liên tục
      setStatus("status.streamingIdle", "on");
      return;
    }
    // Thiết bị thật sự mất -> vào luồng reconnect.
    setStatus("status.signalLost", "err");
    onStreamStalled();
  } catch (_) {
    // lỗi mạng tới server -> không kết luận, giữ nguyên và thử lại sau.
  } finally {
    checkingStall = false;
  }
}

// Stream đứng hình quá lâu: chủ động đóng WS hiện tại và kích hoạt auto-reconnect
// (giống như khi thiết bị bị ngắt). Không đặt manualClose nên sẽ tự quét & nối lại.
function onStreamStalled() {
  if (!connected) return;
  connected = false;
  setConnectBtn(false);
  decoder.reset(); clearScreen();
  $("stats").classList.add("hidden");
  if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} ws = null; }
  staleSecs = 0; everFrame = false;
  scheduleReconnect();
}

// Khi đã kết nối WS nhưng chưa có khung hình: hỏi server trạng thái thiết bị
// để báo rõ đang boot / tắt nguồn / chưa cấp quyền, thay vì thông báo chung chung.
let probingNoVideo = false;
function noVideoFallback() {
  return $("engine").value === "scrcpy" ? t("overlay.noVideoScrcpy") : t("overlay.noVideoScreenrecord");
}
async function explainNoVideo() {
  const fallback = noVideoFallback();
  if (probingNoVideo) return;
  probingNoVideo = true;
  try {
    const token  = $("token").value.trim();
    const serial = $("devices").value;
    const res = await fetch(`/api/device-status?token=${encodeURIComponent(token)}` +
                            `&serial=${encodeURIComponent(serial)}`);
    if (!res.ok) { if (connected && !everFrame) showOverlay(true, null, null, fallback); return; }
    const st = await res.json();
    if (!connected || everFrame) return;     // đã có hình hoặc đã ngắt trong lúc chờ
    const known = ["no_device", "unauthorized", "offline", "booting", "ready"];
    const state = known.includes(st.state) ? st.state : "unknown";
    const title = t(`dev.${state}.title`);
    const reason = state === "unknown" ? t("dev.unknown.reason", { state: st.state }) : t(`dev.${state}.reason`);
    // 'ready' nghĩa là ADB tốt nhưng video vẫn chưa lên -> kèm gợi ý engine cũ.
    const detail = state === "ready" ? `${reason}\n\n${fallback}` : reason;
    showOverlay(true, null, null, `${title}\n${detail}`);
  } catch (e) {
    if (connected && !everFrame) showOverlay(true, null, null, fallback);
  } finally {
    probingNoVideo = false;
  }
}

export function initVideo() {
  $("refresh").onclick = () => loadDevices(false);
  $("connect").onclick = () => (connected ? disconnect() : connect());
  showOverlay(true, "overlay.enterToken");
  startStatsLoop();
  setupClientsToggle();
}

// Ô ping: hover để xem nhanh số client đang kết nối, click để ghim hiển thị.
function setupClientsToggle() {
  const stats = $("stats");
  const row = $("clientsRow");
  if (!stats || !row) return;
  let pinned = false;
  const render = () => row.classList.toggle("hidden", !(pinned || stats.matches(":hover")));
  stats.addEventListener("mouseenter", render);
  stats.addEventListener("mouseleave", render);
  stats.addEventListener("click", () => { pinned = !pinned; render(); });
}
