// core.js — tiện ích dùng chung cho mọi module.

export const $ = (id) => document.getElementById(id);

// localStorage có tiền tố để tránh đụng key.
export const LS = {
  get: (k, d) => {
    const v = localStorage.getItem("adbwc_" + k);
    return v === null ? d : v;
  },
  set: (k, v) => localStorage.setItem("adbwc_" + k, v),
};

// Chọn giao thức WebSocket theo trang (wss khi HTTPS).
export const wsProto = () => (location.protocol === "https:" ? "wss" : "ws");
