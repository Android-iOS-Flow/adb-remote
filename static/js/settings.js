// settings.js — Nạp/lưu cài đặt và nối các ô điều khiển chất lượng.

import { $, LS } from "./core.js";
import { t, onLangChange } from "./i18n.js";

function rateText() { return t("unit.mbps", { n: $("bitrate").value }); }
function fpsText() { return t("unit.fps", { n: $("fps").value }); }

export function updateFpsState() {
  const isScrcpy = $("engine").value === "scrcpy";
  $("fps").disabled = !isScrcpy;
  $("fps").classList.toggle("opacity-40", !isScrcpy);
  $("fpsNote").style.display = isScrcpy ? "none" : "block";
  $("verRow").style.display = isScrcpy ? "block" : "none";
}

export function loadSettings() {
  $("token").value     = LS.get("token", "");
  $("engine").value    = LS.get("engine", "scrcpy");
  $("scrcpyVer").value = LS.get("scrcpyVer", "2.4");
  $("maxsize").value   = LS.get("maxsize", "1024");
  $("bitrate").value   = LS.get("bitrate", "8");
  $("fps").value       = LS.get("fps", "30");
  $("kbd").checked     = LS.get("kbd", "0") === "1";
  $("rateLabel").textContent = rateText();
  $("fpsLabel").textContent  = fpsText();
  updateFpsState();
}

export function saveSettings() {
  LS.set("token", $("token").value.trim());
  LS.set("engine", $("engine").value);
  LS.set("scrcpyVer", $("scrcpyVer").value.trim());
  LS.set("maxsize", $("maxsize").value);
  LS.set("bitrate", $("bitrate").value);
  LS.set("fps", $("fps").value);
  LS.set("kbd", $("kbd").checked ? "1" : "0");
  LS.set("serial", $("devices").value);
}

// reconnectIfConnected: callback (từ main) để kết nối lại khi đổi chất lượng.
export function initSettings(reconnectIfConnected) {
  const onQualityChange = () => {
    $("rateLabel").textContent = rateText();
    $("fpsLabel").textContent  = fpsText();
    updateFpsState();
    saveSettings();
    reconnectIfConnected();
  };

  $("engine").onchange  = onQualityChange;
  $("maxsize").onchange = onQualityChange;
  $("bitrate").oninput  = () => { $("rateLabel").textContent = rateText(); };
  $("bitrate").onchange = onQualityChange;
  $("fps").oninput      = () => { $("fpsLabel").textContent = fpsText(); };
  $("fps").onchange     = onQualityChange;
  $("kbd").onchange     = saveSettings;
  $("token").onchange   = saveSettings;
  $("devices").onchange = () => { saveSettings(); reconnectIfConnected(); };

  document.querySelectorAll(".preset").forEach((b) => {
    b.onclick = () => {
      $("maxsize").value = b.dataset.max;
      $("bitrate").value = b.dataset.rate;
      onQualityChange();
    };
  });

  // Cập nhật nhãn Mbps/fps khi đổi ngôn ngữ.
  onLangChange(() => {
    $("rateLabel").textContent = rateText();
    $("fpsLabel").textContent  = fpsText();
  });

  // Thu/giãn sidebar cài đặt.
  let sidebarOpen = true;
  $("toggleSettings").onclick = () => {
    sidebarOpen = !sidebarOpen;
    const sb = $("sidebar");
    sb.style.width = sidebarOpen ? "20rem" : "0px";
    sb.style.opacity = sidebarOpen ? "1" : "0";
  };
}
