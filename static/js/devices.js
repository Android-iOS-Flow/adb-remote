// devices.js — Quét và hiển thị danh sách thiết bị adb.

import { $, LS } from "./core.js";

// Trả về mảng thiết bị; đồng thời đổ vào <select id="devices">.
// silent=true: không hiện alert (dùng cho auto-reconnect / auto-load).
export async function loadDevices(silent) {
  const token = $("token").value.trim();
  if (!token) { if (!silent) alert("Enter token first."); return []; }
  try {
    const res = await fetch(`/api/devices?token=${encodeURIComponent(token)}`);
    if (!res.ok) { if (!silent) alert("Wrong token or server error."); return []; }
    const list = await res.json();
    const sel = $("devices");
    const prev = sel.value;
    sel.innerHTML = "";
    if (list.length === 0) sel.innerHTML = '<option value="">(no devices)</option>';
    for (const d of list) {
      const opt = document.createElement("option");
      opt.value = d.serial;
      opt.textContent = `${d.model || d.serial} [${d.state}]`;
      sel.appendChild(opt);
    }
    // Giữ lựa chọn cũ nếu còn, nếu không thì khôi phục serial đã lưu.
    const saved = LS.get("serial", "");
    const wanted = [prev, saved].find((s) => s && [...sel.options].some((o) => o.value === s));
    if (wanted) sel.value = wanted;
    return list;
  } catch (e) {
    if (!silent) alert("Failed to load: " + e);
    return [];
  }
}
