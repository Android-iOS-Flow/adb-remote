// files.js — Modal duyệt file trên thiết bị: liệt kê, tải về, upload,
// tạo thư mục, xoá, đổi tên. Dùng REST /api/files* (xem server.py).

import { $ } from "./core.js";
import { t } from "./i18n.js";

let cwd = "/sdcard";          // thư mục hiện tại trên thiết bị
let lastEntries = [];          // entry lần tải gần nhất

// ---------- tiện ích ----------
function token() { return $("token").value.trim(); }
function serial() { return $("devices").value || ""; }

function setState(label) { $("filesState").textContent = label; }

function bar(msg, show = true) {
  const b = $("filesBar");
  b.textContent = msg || "";
  b.classList.toggle("hidden", !show || !msg);
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 ? 0 : 1) + " " + units[i];
}

// Nối path POSIX (thiết bị dùng dấu /).
function joinPath(dir, name) {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}
function parentPath(p) {
  if (!p || p === "/") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

// ---------- tải danh sách ----------
async function loadDir(path) {
  if (!token()) { alert(t("files.enterTokenFirst")); return; }
  setState(t("files.loading"));
  $("filesError").classList.add("hidden");
  try {
    const url = `/api/files?token=${encodeURIComponent(token())}` +
                `&serial=${encodeURIComponent(serial())}&path=${encodeURIComponent(path)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      showError(detail.detail || t("files.errStatus", { status: res.status }));
      setState(t("files.error"));
      return;
    }
    const data = await res.json();
    cwd = data.path || path;
    $("filesPath").value = cwd;
    if (data.error) { showError(data.error); lastEntries = []; renderList(); setState(t("files.idle")); return; }
    lastEntries = data.entries || [];
    renderList();
    setState(t("files.entryCount", { n: lastEntries.length }));
  } catch (e) {
    showError(t("files.loadFailed", { err: e }));
    setState(t("files.error"));
  }
}

function showError(msg) {
  const el = $("filesError");
  el.textContent = msg;
  el.classList.remove("hidden");
  $("filesEmpty").classList.add("hidden");
  $("filesList").innerHTML = "";
}

// ---------- vẽ bảng ----------
function renderList() {
  const tbody = $("filesList");
  tbody.innerHTML = "";
  $("filesError").classList.add("hidden");
  $("filesEmpty").classList.toggle("hidden", lastEntries.length !== 0);
  if (lastEntries.length === 0) return;

  for (const e of lastEntries) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-slate-100 hover:bg-slate-50";

    // Cột tên (icon + tên; nhấp thư mục để vào).
    const tdName = document.createElement("td");
    tdName.className = "px-3 py-1.5 max-w-0";
    const wrap = document.createElement("div");
    wrap.className = "flex items-center gap-2 min-w-0";
    const icon = document.createElement("span");
    icon.className = "shrink-0";
    icon.textContent = e.is_dir ? "📁" : (e.is_link ? "🔗" : "📄");
    const label = document.createElement("span");
    label.className = "truncate font-mono text-[13px]" +
      (e.is_dir ? " text-blue-700 cursor-pointer hover:underline" : " text-slate-700");
    label.textContent = e.name + (e.is_link && e.link_target ? `  → ${e.link_target}` : "");
    label.title = e.name;
    if (e.is_dir) label.onclick = () => loadDir(joinPath(cwd, e.name));
    wrap.append(icon, label);
    tdName.appendChild(wrap);

    // Kích thước.
    const tdSize = document.createElement("td");
    tdSize.className = "px-3 py-1.5 text-right text-[12px] text-slate-500 font-mono";
    tdSize.textContent = e.is_dir ? "—" : humanSize(e.size);

    // Thời gian sửa.
    const tdTime = document.createElement("td");
    tdTime.className = "px-3 py-1.5 text-[12px] text-slate-400 font-mono hidden sm:table-cell";
    tdTime.textContent = e.mtime || "";

    // Hành động.
    const tdAct = document.createElement("td");
    tdAct.className = "px-3 py-1.5 text-right whitespace-nowrap w-28";
    const full = joinPath(cwd, e.name);
    if (!e.is_dir) {
      tdAct.appendChild(actionBtn(ICON.download, t("files.download"), () => downloadFile(full)));
    }
    tdAct.appendChild(actionBtn(ICON.rename, t("files.rename"), () => renameEntry(e.name)));
    tdAct.appendChild(actionBtn(ICON.trash, t("files.delete"), () => deleteEntry(full, e.is_dir), "text-red-500 hover:bg-red-50"));

    tr.append(tdName, tdSize, tdTime, tdAct);
    tbody.appendChild(tr);
  }
}

// Icon SVG (hiển thị ổn định trên mọi font, không phụ thuộc ký tự unicode).
const ICON = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"/></svg>',
  rename:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5h6a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2v-6M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m2 0v12a1 1 0 01-1 1H7a1 1 0 01-1-1V7"/></svg>',
};

function actionBtn(svg, title, onClick, extra = "hover:bg-slate-100") {
  const b = document.createElement("button");
  b.className = `ml-1 inline-grid place-items-center w-7 h-7 rounded text-slate-500 ${extra} transition`;
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = onClick;
  return b;
}

// ---------- tải về ----------
function downloadFile(path) {
  // Mở trong tab/iframe ẩn để trình duyệt tự lưu (Content-Disposition: attachment).
  const url = `/api/files/download?token=${encodeURIComponent(token())}` +
              `&serial=${encodeURIComponent(serial())}&path=${encodeURIComponent(path)}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  bar(t("files.downloading", { path }));
  setTimeout(() => bar("", false), 4000);
}

// ---------- upload ----------
// Upload 1 file qua XHR để theo dõi tiến trình (fetch không báo % upload).
function uploadOne(f, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("token", token());
    fd.append("serial", serial());
    fd.append("dest", cwd);
    fd.append("file", f, f.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files/upload");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(ev.loaded, ev.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let detail = t("files.errStatus", { status: xhr.status });
        try { detail = JSON.parse(xhr.responseText).detail || detail; } catch (_) {}
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error(t("files.connError")));
    xhr.send(fd);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let done = 0;
  for (const f of files) {
    const idx = ++done;
    const sizeStr = humanSize(f.size);
    try {
      await uploadOne(f, (loaded, total) => {
        const pct = total ? Math.floor((loaded / total) * 100) : 0;
        bar(t("files.uploading", { idx, total: files.length, name: f.name, pct, loaded: humanSize(loaded), size: sizeStr }));
      });
      // 100% (đẩy lên xong) — server còn đang adb push xuống thiết bị.
      bar(t("files.uploadWriting", { idx, total: files.length, name: f.name }));
    } catch (e) {
      alert(t("files.uploadFailed", { name: f.name, err: e.message }));
    }
  }
  bar(t("files.uploadDone"), true);
  setTimeout(() => bar("", false), 3000);
  loadDir(cwd);
}

// ---------- mkdir / xoá / đổi tên ----------
async function postForm(endpoint, fields) {
  const fd = new FormData();
  fd.append("token", token());
  fd.append("serial", serial());
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(endpoint, { method: "POST", body: fd });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.detail || t("files.errStatus", { status: res.status }));
  }
  return res.json();
}

async function makeDir() {
  const name = prompt(t("files.promptMkdir"), "");
  if (!name) return;
  try {
    await postForm("/api/files/mkdir", { path: joinPath(cwd, name.trim()) });
    loadDir(cwd);
  } catch (e) { alert(t("files.mkdirFailed", { err: e.message })); }
}

async function deleteEntry(path, isDir) {
  const what = isDir ? t("files.confirmDeleteDir") : t("files.confirmDeleteFile");
  if (!confirm(t("files.confirmDelete", { what, path }))) return;
  try {
    await postForm("/api/files/delete", { path });
    loadDir(cwd);
  } catch (e) { alert(t("files.deleteFailed", { err: e.message })); }
}

async function renameEntry(oldName) {
  const next = prompt(t("files.promptRename"), oldName);
  if (!next || next === oldName) return;
  // Nếu không chứa '/', coi như đổi tên trong cùng thư mục.
  const dst = next.includes("/") ? next : joinPath(cwd, next.trim());
  try {
    await postForm("/api/files/rename", { src: joinPath(cwd, oldName), dst });
    loadDir(cwd);
  } catch (e) { alert(t("files.renameFailed", { err: e.message })); }
}

// ---------- khởi tạo ----------
export function initFiles() {
  $("openFiles").onclick = () => {
    $("filesModal").classList.remove("hidden");
    loadDir(cwd);
  };
  $("closeFiles").onclick = () => { $("filesModal").classList.add("hidden"); };
  $("filesReload").onclick = () => loadDir(cwd);
  $("filesUp").onclick = () => loadDir(parentPath(cwd));
  $("filesGo").onclick = () => loadDir($("filesPath").value.trim() || "/sdcard");
  $("filesPath").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); loadDir($("filesPath").value.trim() || "/sdcard"); }
  });
  $("filesMkdir").onclick = makeDir;
  $("filesUpload").onclick = () => $("filesUploadInput").click();
  $("filesUploadInput").onchange = (ev) => {
    uploadFiles(ev.target.files);
    ev.target.value = "";   // reset để chọn lại cùng file vẫn kích hoạt
  };
  document.querySelectorAll(".filesQuick").forEach((b) => {
    b.onclick = () => loadDir(b.dataset.path);
  });
}
