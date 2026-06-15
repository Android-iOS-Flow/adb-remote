// settings.js — Nạp/lưu cài đặt và nối các ô điều khiển chất lượng.

import { $, LS } from "./core.js";

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
  $("rateLabel").textContent = $("bitrate").value + " Mbps";
  $("fpsLabel").textContent  = $("fps").value + " fps";
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
    $("rateLabel").textContent = $("bitrate").value + " Mbps";
    $("fpsLabel").textContent  = $("fps").value + " fps";
    updateFpsState();
    saveSettings();
    reconnectIfConnected();
  };

  $("engine").onchange  = onQualityChange;
  $("maxsize").onchange = onQualityChange;
  $("bitrate").oninput  = () => { $("rateLabel").textContent = $("bitrate").value + " Mbps"; };
  $("bitrate").onchange = onQualityChange;
  $("fps").oninput      = () => { $("fpsLabel").textContent = $("fps").value + " fps"; };
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

  // Thu/giãn sidebar cài đặt.
  let sidebarOpen = true;
  $("toggleSettings").onclick = () => {
    sidebarOpen = !sidebarOpen;
    const sb = $("sidebar");
    sb.style.width = sidebarOpen ? "20rem" : "0px";
    sb.style.opacity = sidebarOpen ? "1" : "0";
  };
}
