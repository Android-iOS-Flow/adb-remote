// input.js — Chuột/cảm ứng -> tap/swipe; phím cứng; bàn phím -> text/keyevent.

import { $ } from "./core.js";
import { sendInput, getDevice } from "./video.js";

const SPECIAL = new Set(["Backspace", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function initInput() {
  const canvas = $("screen");
  let down = null;

  const toDevice = (ev) => {
    const r = canvas.getBoundingClientRect();
    const d = getDevice();
    const rx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const ry = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    return { x: Math.round(rx * d.width), y: Math.round(ry * d.height) };
  };

  canvas.addEventListener("pointerdown", (ev) => {
    ev.preventDefault(); canvas.setPointerCapture(ev.pointerId);
    const p = toDevice(ev); down = { ...p, t: performance.now() };
  });
  canvas.addEventListener("pointerup", (ev) => {
    if (!down) return; ev.preventDefault();
    const p = toDevice(ev);
    const dt = performance.now() - down.t;
    const dist = Math.hypot(p.x - down.x, p.y - down.y);
    if (dist < 12 && dt < 400) sendInput({ type: "tap", x: down.x, y: down.y });
    else sendInput({ type: "swipe", x1: down.x, y1: down.y, x2: p.x, y2: p.y,
                     duration: Math.max(50, Math.min(800, Math.round(dt))) });
    down = null;
  });
  canvas.addEventListener("pointercancel", () => { down = null; });

  document.querySelectorAll(".navbtn").forEach((b) => {
    b.onclick = () => sendInput({ type: "key", name: b.dataset.key });
  });

  window.addEventListener("keydown", (ev) => {
    if (!$("kbd").checked) return;
    // Bỏ qua khi đang gõ vào ô nhập hoặc khi popup Scripts đang mở.
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
    if (!$("scriptsModal").classList.contains("hidden")) return;
    if (!$("terminalModal").classList.contains("hidden")) return;
    if (SPECIAL.has(ev.key)) { ev.preventDefault(); sendInput({ type: "key", name: ev.key }); }
    else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault(); sendInput({ type: "text", text: ev.key });
    }
  });
}
