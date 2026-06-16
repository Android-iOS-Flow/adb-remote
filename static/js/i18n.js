// i18n.js — Hỗ trợ đa ngôn ngữ (vi/en/zh/ko/th/hi).
//
// Bảng dịch được tách thành từng file trong thư mục locales/ (mỗi ngôn ngữ 1 file).
// Khoá nào thiếu ở một ngôn ngữ sẽ TỰ ĐỘNG fallback về tiếng Anh (xem hàm t()).
//
// Cách dùng:
//   - Trong HTML: data-i18n="key" (textContent), data-i18n-ph="key" (placeholder),
//     data-i18n-title="key" (title).
//   - Trong JS: import { t } from "./i18n.js"; t("key", {name: "x"}).
//   - Đổi ngôn ngữ: setLang("en") -> tự applyTranslations() + gọi callback.
//
// Thêm ngôn ngữ mới: tạo locales/<code>.js (export default {...}), import vào đây,
// thêm vào MESSAGES và LANGS. Không cần đủ mọi khoá — thiếu thì dùng tiếng Anh.

import { LS } from "./core.js";

import en from "./locales/en.js";
import vi from "./locales/vi.js";
import zh from "./locales/zh.js";
import ko from "./locales/ko.js";
import th from "./locales/th.js";
import hi from "./locales/hi.js";

export const LANGS = [
  { code: "vi", label: "Tiếng Việt", flag: "🇻🇳" },
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
  { code: "th", label: "ไทย", flag: "🇹🇭" },
  { code: "hi", label: "हिन्दी", flag: "🇮🇳" },
];

const MESSAGES = { en, vi, zh, ko, th, hi };

let currentLang = LS.get("lang", "") || detectLang();
const langChangeCbs = [];

function detectLang() {
  const nav = (navigator.language || "en").toLowerCase();
  for (const { code } of LANGS) {
    if (nav === code || nav.startsWith(code + "-")) return code;
  }
  return "en";
}

export function getLang() { return currentLang; }

export function onLangChange(cb) { langChangeCbs.push(cb); }

// Lấy chuỗi dịch theo khoá; thay {param} bằng giá trị truyền vào.
// Thiếu khoá ở ngôn ngữ hiện tại -> dùng tiếng Anh; thiếu cả EN -> trả về khoá.
export function t(key, params) {
  const table = MESSAGES[currentLang] || MESSAGES.en;
  let s = table[key];
  if (s === undefined) s = MESSAGES.en[key];
  if (s === undefined) return key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? params[k] : m));
  }
  return s;
}

// Quét DOM và áp bản dịch cho mọi phần tử có data-i18n*.
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  });
  document.documentElement.lang = currentLang;
  document.title = t("app.title");
}

export function setLang(code) {
  if (!MESSAGES[code]) return;
  currentLang = code;
  LS.set("lang", code);
  applyTranslations();
  for (const cb of langChangeCbs) { try { cb(code); } catch (_) {} }
}

export function initI18n() {
  applyTranslations();
}
