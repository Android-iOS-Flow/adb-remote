// main.js — Điểm vào: lắp ráp các module và khởi động.

import { $, LS } from "./core.js";
import { loadSettings, initSettings } from "./settings.js";
import { loadDevices } from "./devices.js";
import { initVideo, connect, isConnected } from "./video.js";
import { initInput } from "./input.js";
import { initScripts } from "./scripts.js";
import { initLogcat } from "./logcat.js";
import { initTerminal } from "./terminal.js";
import { initEvents, clientName } from "./events.js";

// Gán class cho các nút động (Tailwind không quét class trong chuỗi JS).
function styleDynamicButtons() {
  document.querySelectorAll(".navbtn").forEach((b) => {
    b.className = "navbtn text-xs px-2 py-1.5 rounded-lg border border-slate-300 " +
                  "text-slate-700 hover:bg-slate-50 active:bg-slate-100 transition";
  });
  document.querySelectorAll(".lvlbtn").forEach((b) => {
    b.className = "lvlbtn text-xs px-2 py-1 rounded border border-slate-300 font-mono " +
                  "text-slate-700 hover:bg-slate-50 transition";
  });
  document.querySelectorAll(".quickcmd").forEach((b) => {
    b.className = "quickcmd text-xs px-2 py-1 rounded-lg border border-slate-300 font-mono " +
                  "text-slate-700 hover:bg-slate-50 transition";
  });
}

styleDynamicButtons();
loadSettings();

// Tên máy hiển thị cho người khác (lưu localStorage).
$("clientName").value = clientName();
$("clientName").onchange = () => {
  const v = $("clientName").value.trim();
  LS.set("clientName", v || clientName());
  $("clientName").value = LS.get("clientName", "");
};

initVideo();
initInput();
initScripts();
initLogcat();
initTerminal();
initEvents();                                             // kênh thông báo chung
initSettings(() => { if (isConnected()) connect(); });   // đổi chất lượng -> kết nối lại

// Tự kết nối nếu đã có token lưu sẵn.
(async function autoStart() {
  if ($("token").value.trim()) {
    const list = await loadDevices(true);
    if (list.length > 0) connect();
  }
})();
