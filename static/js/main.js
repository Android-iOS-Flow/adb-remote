// main.js — Điểm vào: lắp ráp các module và khởi động.

import { $, LS } from "./core.js";
import { initI18n, applyTranslations, setLang, getLang, onLangChange, t, LANGS } from "./i18n.js";
import { loadSettings, initSettings } from "./settings.js";
import { loadDevices } from "./devices.js";
import { initVideo, connect, isConnected, refreshOverlayText } from "./video.js";
import { initInput } from "./input.js";
import { initScripts } from "./scripts.js";
import { initLogcat } from "./logcat.js";
import { initTerminal } from "./terminal.js";
import { initFiles } from "./files.js";
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

// ---------- Bộ chọn ngôn ngữ (header) ----------
function initLanguageMenu() {
  const btn = $("langBtn");
  const menu = $("langMenu");
  const current = $("langCurrent");

  function syncCurrentLabel() {
    const l = LANGS.find((x) => x.code === getLang());
    if (l && current) current.textContent = l.flag + " " + l.code.toUpperCase();
  }

  // Dựng danh sách ngôn ngữ.
  menu.innerHTML = "";
  for (const l of LANGS) {
    const item = document.createElement("button");
    item.className = "w-full text-left px-3 py-2 text-sm hover:bg-slate-100 flex items-center gap-2";
    item.innerHTML = `<span>${l.flag}</span><span>${l.label}</span>`;
    item.onclick = () => { setLang(l.code); menu.classList.add("hidden"); };
    menu.appendChild(item);
  }

  btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) menu.classList.add("hidden");
  });

  syncCurrentLabel();
  onLangChange(syncCurrentLabel);
}

// ---------- Onboarding token (chặn toàn trang đến khi token hợp lệ) ----------
function showOnboarding(prefill) {
  return new Promise((resolve) => {
    const modal = $("onboardModal");
    const input = $("onboardToken");
    const submit = $("onboardSubmit");
    const errEl = $("onboardError");
    input.value = prefill || "";
    errEl.classList.add("hidden");
    modal.classList.remove("hidden");
    setTimeout(() => input.focus(), 50);

    function showErr(key) { errEl.textContent = t(key); errEl.classList.remove("hidden"); }

    async function attempt() {
      const token = input.value.trim();
      if (!token) { showErr("onboard.empty"); return; }
      submit.disabled = true;
      const prevText = submit.textContent;
      submit.textContent = t("onboard.verifying");
      errEl.classList.add("hidden");
      try {
        const res = await fetch(`/api/verify-token?token=${encodeURIComponent(token)}`);
        const data = await res.json().catch(() => ({ ok: false }));
        if (data.ok) {
          LS.set("token", token);
          $("token").value = token;
          modal.classList.add("hidden");
          submit.textContent = prevText;
          submit.disabled = false;
          submit.onclick = null;
          resolve(token);
          return;
        }
        showErr("onboard.wrong");
      } catch (_) {
        showErr("onboard.serverError");
      }
      submit.textContent = prevText;
      submit.disabled = false;
    }

    submit.onclick = attempt;
    input.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); attempt(); } };
  });
}

// Kiểm tra token đã lưu còn hợp lệ không (im lặng).
async function tokenIsValid(token) {
  if (!token) return false;
  try {
    const res = await fetch(`/api/verify-token?token=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({ ok: false }));
    return !!data.ok;
  } catch (_) {
    return false;   // không kết nối được server -> coi như cần onboarding
  }
}

// ---------- Khởi động ----------
styleDynamicButtons();
initI18n();
initLanguageMenu();
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
initFiles();
initEvents();                                             // kênh thông báo chung
initSettings(() => { if (isConnected()) connect(); });   // đổi chất lượng -> kết nối lại

// Cập nhật phần text động (overlay video) khi đổi ngôn ngữ.
onLangChange(() => { refreshOverlayText(); });

// Luồng vào app: xác thực token (hoặc onboarding) rồi tự kết nối.
(async function boot() {
  let token = $("token").value.trim();
  if (!(await tokenIsValid(token))) {
    token = await showOnboarding(token);   // chặn đến khi nhập đúng
  }
  // Có token hợp lệ -> nạp thiết bị và tự kết nối nếu có.
  const list = await loadDevices(true);
  if (list.length > 0) connect();
})();
