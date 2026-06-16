// terminal.js — Terminal web chạy lệnh adb / fastboot (stream output + stdin).

import { $, wsProto } from "./core.js";
import { t } from "./i18n.js";

let tWs = null;
let tRunning = false;
const history = [];
let histIdx = -1;

function tout(text) {
  const out = $("termOut");
  const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 8;
  out.textContent += text;
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function setRunning(running) {
  tRunning = running;
  $("termStop").disabled = !running;
  $("termState").textContent = running ? t("terminal.running") : t("terminal.idle");
}

function connect() {
  const token = $("token").value.trim();
  if (!token) { tout(t("terminal.enterTokenFirst")); return; }
  if (tWs) { tWs.onclose = null; tWs.close(); }
  tWs = new WebSocket(`${wsProto()}://${location.host}/terminal?token=${encodeURIComponent(token)}`);
  tWs.onopen = () => { $("termState").textContent = t("terminal.ready"); };
  tWs.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "out") tout(msg.data);
    else if (msg.type === "done") { tout(t("terminal.exitLine", { code: msg.code })); setRunning(false); }
  };
  tWs.onclose = () => { tWs = null; setRunning(false); $("termState").textContent = t("terminal.disconnected"); };
  tWs.onerror = () => tout(t("terminal.connError"));
}

function ensureConnected() {
  if (!tWs || tWs.readyState > 1) connect();
}

function buildCmd(line) {
  let cmd = line.trim();
  if (!cmd) return cmd;
  // "Target selected device": chèn -s <serial> cho lệnh adb nếu chưa có.
  if ($("termTarget").checked) {
    const s = $("devices").value;
    if (s && /^adb\b/i.test(cmd) && !/\s-s\s/.test(cmd)) {
      cmd = cmd.replace(/^adb\b/i, `adb -s ${s}`);
    }
  }
  return cmd;
}

function submit() {
  const box = $("termIn");
  const line = box.value;
  if (tRunning) {
    // Đang chạy -> gửi xuống stdin (vd trả lời prompt, hoặc nhập lệnh adb shell tương tác).
    if (tWs && tWs.readyState === WebSocket.OPEN) {
      tout(line + "\n");
      tWs.send(JSON.stringify({ type: "stdin", data: line }));
    }
    box.value = "";
    return;
  }
  const cmd = buildCmd(line);
  if (!cmd) return;
  ensureConnected();
  if (!tWs || tWs.readyState !== WebSocket.OPEN) {
    // Vừa mở kết nối -> đợi onopen rồi gửi.
    const send = () => { tWs.send(JSON.stringify({ type: "run", cmd })); tWs.removeEventListener("open", send); };
    tWs.addEventListener("open", send);
  } else {
    tWs.send(JSON.stringify({ type: "run", cmd }));
  }
  tout("> " + cmd + "\n");
  setRunning(true);
  history.push(line); histIdx = history.length;
  box.value = "";
}

function runQuick(cmd) {
  $("termIn").value = cmd;
  submit();
}

export function initTerminal() {
  $("openTerminal").onclick = () => {
    $("terminalModal").classList.remove("hidden");
    ensureConnected();
    $("termIn").focus();
  };
  $("closeTerminal").onclick = () => { $("terminalModal").classList.add("hidden"); };
  $("termRun").onclick = submit;
  $("termStop").onclick = () => { if (tWs) tWs.send(JSON.stringify({ type: "kill" })); };
  $("termClear").onclick = () => { $("termOut").textContent = ""; };

  $("termIn").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (histIdx > 0) { histIdx--; $("termIn").value = history[histIdx]; }
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (histIdx < history.length - 1) { histIdx++; $("termIn").value = history[histIdx]; }
      else { histIdx = history.length; $("termIn").value = ""; }
    }
  });

  document.querySelectorAll(".quickcmd").forEach((b) => {
    b.onclick = () => runQuick(b.dataset.cmd);
  });
}
