"""
events.py - Hub sự kiện in-memory để phối hợp nhiều máy khách.

- Giữ danh sách script ĐANG CHẠY (registry).
- Quảng bá (broadcast) các thay đổi tới mọi client đã đăng ký qua /events.

Server chạy single event loop nên không cần khoá; chỉ cần lặp trên bản sao
của tập subscriber khi broadcast (vì có await ở giữa).
"""

import itertools
import json
import time

from fastapi import WebSocket


class Hub:
    def __init__(self):
        self.subscribers: set[WebSocket] = set()
        self.running: dict[int, dict] = {}     # id -> {id,path,label,who,started}
        self._ids = itertools.count(1)

    # ---- subscriber ----
    async def subscribe(self, ws: WebSocket) -> None:
        self.subscribers.add(ws)
        await ws.send_text(json.dumps(self._snapshot()))

    def unsubscribe(self, ws: WebSocket) -> None:
        self.subscribers.discard(ws)

    def _snapshot(self) -> dict:
        return {"type": "snapshot", "running": list(self.running.values())}

    async def _broadcast(self, msg: dict) -> None:
        data = json.dumps(msg)
        for ws in list(self.subscribers):
            try:
                await ws.send_text(data)
            except Exception:
                self.subscribers.discard(ws)

    # ---- registry script đang chạy ----
    async def started(self, path: str, label: str, who: str) -> int:
        rid = next(self._ids)
        info = {"id": rid, "path": path, "label": label, "who": who or "someone", "started": time.time()}
        self.running[rid] = info
        await self._broadcast({"type": "started", **info})
        return rid

    async def finished(self, rid: int, code) -> None:
        info = self.running.pop(rid, None)
        if info is None:
            return
        await self._broadcast({
            "type": "finished",
            "id": rid,
            "path": info["path"],
            "label": info["label"],
            "who": info["who"],
            "code": code,
        })


# Hub dùng chung cho toàn ứng dụng.
hub = Hub()
