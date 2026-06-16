"""
server.py - Web server điều khiển điện thoại Android từ xa qua trình duyệt.

Luồng hoạt động:
  Browser  --(WebSocket)-->  server.py  --(adb)-->  Android device
     |  <-- binary H.264 frames (screenrecord) <--        |
     |  --> JSON input (tap/swipe/text/key) -->           |

Bảo mật: mọi truy cập cần AUTH_TOKEN. Mặc định chỉ lắng nghe 127.0.0.1;
để dùng qua Internet hãy bọc bằng SSH tunnel / cloudflared / tailscale
(xem README) thay vì mở cổng trực tiếp.
"""

import json
import mimetypes
import os
import posixpath
import tempfile
import urllib.parse

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, Header, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import anyio

# Ép MIME đúng cho file JS/ES module. Trên Windows, mimetypes đôi khi trả .js
# thành text/plain (đọc từ registry) khiến trình duyệt từ chối nạp ES module
# -> mọi nút "không có hiện tượng gì". Dòng dưới sửa triệt để việc này.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")

import adb
import runner
import events
import terminal

load_dotenv()

AUTH_TOKEN = os.environ.get("AUTH_TOKEN", "")
VIDEO_BITRATE = int(os.environ.get("VIDEO_BITRATE", "6000000"))
VIDEO_SIZE = os.environ.get("VIDEO_SIZE", "").strip()
SCRCPY_JAR = os.environ.get("SCRCPY_SERVER_JAR", "").strip()
SCRCPY_VERSION = os.environ.get("SCRCPY_VERSION", "2.4").strip()
SCRCPY_AUTO_DOWNLOAD = os.environ.get("SCRCPY_AUTO_DOWNLOAD", "1").strip().lower() not in ("0", "false", "no")
FASTBOOT_PATH = os.environ.get("FASTBOOT_PATH", "fastboot")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# Thư mục chứa .bat (mặc định scripts/ cạnh server.py, override bằng BAT_DIR).
BAT_DIR = os.environ.get("BAT_DIR", "").strip() or os.path.join(os.path.dirname(__file__), "scripts")
BAT_DIR = os.path.abspath(BAT_DIR)
os.makedirs(BAT_DIR, exist_ok=True)

# File manifest liệt kê các .bat tuỳ chỉnh (có thể ở bất kỳ đâu trên máy).
# Mặc định scripts/scripts.list; đổi bằng SCRIPTS_MANIFEST.
SCRIPTS_MANIFEST = os.environ.get("SCRIPTS_MANIFEST", "").strip() or os.path.join(BAT_DIR, "scripts.list")
SCRIPTS_MANIFEST = os.path.abspath(SCRIPTS_MANIFEST)

# File log ghi lại các lệnh stdin gửi xuống script (đổi bằng STDIN_LOG).
STDIN_LOG = os.environ.get("STDIN_LOG", "").strip() or os.path.join(os.path.dirname(__file__), "logs", "stdin.log")
STDIN_LOG = os.path.abspath(STDIN_LOG)
os.makedirs(os.path.dirname(STDIN_LOG), exist_ok=True)

app = FastAPI(title="ADB Web Control")

# Số client đang kết nối tới luồng video /ws (để hiển thị khi hover/click vào ô ping).
WS_CLIENTS = 0


@app.middleware("http")
async def no_cache_assets(request, call_next):
    """Không cache HTML/JS để trình duyệt luôn nạp bản mới (tránh kẹt JS cũ)."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


def check_token(token: str) -> None:
    if not AUTH_TOKEN:
        raise HTTPException(status_code=500, detail="AUTH_TOKEN chưa được cấu hình trên server.")
    if token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Token không hợp lệ.")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/devices")
async def api_devices(token: str = Query("")):
    check_token(token)
    return JSONResponse(await adb.list_devices())


@app.get("/api/device-status")
async def api_device_status(token: str = Query(""), serial: str = Query("")):
    """Trạng thái chi tiết của thiết bị (no_device/unauthorized/offline/booting/ready)."""
    check_token(token)
    return JSONResponse(await adb.probe_device(serial or None))


@app.get("/api/verify-token")
async def api_verify_token(token: str = Query("")):
    """Kiểm tra token có khớp AUTH_TOKEN không (dùng cho màn hình onboarding)."""
    return JSONResponse({"ok": bool(AUTH_TOKEN) and token == AUTH_TOKEN})


def _norm(p: str) -> str:
    """Chuẩn hoá path để so sánh (Windows: không phân biệt hoa thường)."""
    return os.path.normcase(os.path.abspath(p))


def _expand(p: str) -> str:
    """Mở rộng ~ và biến môi trường (vd %USERPROFILE%), rồi tuyệt đối hoá."""
    return os.path.abspath(os.path.expandvars(os.path.expanduser(p)))


def _parse_manifest(mpath: str):
    """
    Đọc file manifest liệt kê .bat (mỗi dòng một file, có thể ở bất kỳ đâu).

    Cú pháp mỗi dòng:
      C:\\path\\to\\file.bat
      Tên hiển thị = C:\\path\\to\\file.bat
    Dòng bắt đầu bằng # hoặc ; là chú thích. Hỗ trợ %BIENMOITRUONG% và ~.
    Trả về list (label, abspath).
    """
    entries = []
    if not os.path.isfile(mpath):
        return entries
    try:
        with open(mpath, encoding="utf-8-sig", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or line.startswith(";"):
                    continue
                if "=" in line:
                    label, p = line.split("=", 1)
                    label, p = label.strip(), p.strip()
                else:
                    label, p = "", line
                p = p.strip().strip('"').strip()
                if not p:
                    continue
                p_abs = _expand(p)
                if not label:
                    label = os.path.basename(p_abs)
                entries.append((label, p_abs))
    except OSError:
        pass
    return entries


def list_scripts():
    """Gộp .bat trong BAT_DIR và các mục trong manifest (dedup theo path)."""
    items = []
    seen = set()
    try:
        for name in sorted(os.listdir(BAT_DIR)):
            full = os.path.join(BAT_DIR, name)
            if os.path.isfile(full) and name.lower().endswith(".bat"):
                key = _norm(full)
                if key not in seen:
                    seen.add(key)
                    items.append({"label": name, "path": os.path.abspath(full), "missing": False})
    except OSError:
        pass
    for label, p in _parse_manifest(SCRIPTS_MANIFEST):
        if not p.lower().endswith(".bat"):
            continue
        key = _norm(p)
        if key in seen:
            continue
        seen.add(key)
        items.append({"label": label, "path": p, "missing": not os.path.isfile(p)})
    return items


def _allowed_keys():
    """Tập path hợp lệ (đã chuẩn hoá) - chỉ các file thật sự tồn tại."""
    return {_norm(i["path"]) for i in list_scripts() if not i["missing"]}


@app.get("/api/scripts")
async def api_scripts(token: str = Query("")):
    """Liệt kê các .bat có thể chạy (thư mục scripts/ + manifest)."""
    check_token(token)
    return JSONResponse({"dir": BAT_DIR, "manifest": SCRIPTS_MANIFEST, "items": list_scripts()})


# ---------------------------------------------------------------------------
# Quản lý file trên thiết bị (duyệt / tải / upload / mkdir / xoá / đổi tên)
# ---------------------------------------------------------------------------

def _serial_or_none(serial: str):
    return serial or None


@app.get("/api/files")
async def api_files_list(token: str = Query(""), serial: str = Query(""), path: str = Query("/sdcard")):
    """Liệt kê nội dung một thư mục trên thiết bị."""
    check_token(token)
    try:
        result = await adb.list_dir(_serial_or_none(serial), path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi liệt kê: {e}")
    return JSONResponse(result)


@app.get("/api/files/download")
async def api_files_download(token: str = Query(""), serial: str = Query(""), path: str = Query("")):
    """Stream một file từ thiết bị về trình duyệt (tải xuống)."""
    check_token(token)
    if not path:
        raise HTTPException(status_code=400, detail="Thiếu path.")
    serial = _serial_or_none(serial)
    info = await adb.stat_remote(serial, path)
    if not info["exists"]:
        raise HTTPException(status_code=404, detail="File không tồn tại trên thiết bị.")
    if info["is_dir"]:
        raise HTTPException(status_code=400, detail="Không thể tải thư mục (chỉ hỗ trợ file đơn).")

    norm = info["path"]
    filename = posixpath.basename(norm) or "download"
    # RFC 5987: hỗ trợ tên file có ký tự unicode.
    quoted = urllib.parse.quote(filename)
    disposition = f"attachment; filename*=UTF-8''{quoted}"

    return StreamingResponse(
        adb.stream_pull(serial, norm),
        media_type="application/octet-stream",
        headers={"Content-Disposition": disposition},
    )


@app.post("/api/files/upload")
async def api_files_upload(
    token: str = Form(""),
    serial: str = Form(""),
    dest: str = Form(""),
    file: UploadFile = File(...),
):
    """Nhận 1 file từ trình duyệt, lưu tạm rồi `adb push` lên thư mục dest."""
    check_token(token)
    if not dest:
        raise HTTPException(status_code=400, detail="Thiếu thư mục đích.")
    serial = _serial_or_none(serial)
    name = posixpath.basename(file.filename or "upload")
    if not name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="Tên file không hợp lệ.")
    remote_path = adb.normalize_remote(dest.rstrip("/") + "/" + name)

    # Lưu nội dung upload ra file tạm trên máy chủ rồi push (adb push cần đường dẫn thật).
    tmp_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = tmp.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)
        ok, msg = await adb.push_file(serial, tmp_path, remote_path)
    finally:
        await file.close()
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    if not ok:
        raise HTTPException(status_code=500, detail=f"Upload thất bại: {msg}")
    return JSONResponse({"ok": True, "path": remote_path})


@app.post("/api/files/mkdir")
async def api_files_mkdir(token: str = Form(""), serial: str = Form(""), path: str = Form("")):
    """Tạo thư mục mới (mkdir -p)."""
    check_token(token)
    if not path:
        raise HTTPException(status_code=400, detail="Thiếu path.")
    ok, msg = await adb.mkdir_remote(_serial_or_none(serial), path)
    if not ok:
        raise HTTPException(status_code=500, detail=f"Tạo thư mục thất bại: {msg}")
    return JSONResponse({"ok": True})


@app.post("/api/files/delete")
async def api_files_delete(token: str = Form(""), serial: str = Form(""), path: str = Form("")):
    """Xoá file hoặc thư mục (đệ quy)."""
    check_token(token)
    if not path:
        raise HTTPException(status_code=400, detail="Thiếu path.")
    ok, msg = await adb.remove_remote(_serial_or_none(serial), path)
    if not ok:
        raise HTTPException(status_code=500, detail=f"Xoá thất bại: {msg}")
    return JSONResponse({"ok": True})


@app.post("/api/files/rename")
async def api_files_rename(token: str = Form(""), serial: str = Form(""), src: str = Form(""), dst: str = Form("")):
    """Đổi tên / di chuyển (mv)."""
    check_token(token)
    if not src or not dst:
        raise HTTPException(status_code=400, detail="Thiếu src hoặc dst.")
    ok, msg = await adb.move_remote(_serial_or_none(serial), src, dst)
    if not ok:
        raise HTTPException(status_code=500, detail=f"Đổi tên thất bại: {msg}")
    return JSONResponse({"ok": True})


@app.websocket("/events")
async def ws_events(websocket: WebSocket, token: str = Query("")):
    """Kênh quảng bá: thông báo script nào đang chạy cho mọi máy khách."""
    if not AUTH_TOKEN or token != AUTH_TOKEN:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    await events.hub.subscribe(websocket)
    try:
        while True:
            await websocket.receive_text()   # giữ kết nối / phát hiện đóng
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        events.hub.unsubscribe(websocket)


@app.websocket("/run")
async def ws_run(websocket: WebSocket, token: str = Query(""), path: str = Query(""), who: str = Query("")):
    if not AUTH_TOKEN or token != AUTH_TOKEN:
        await websocket.close(code=4401)
        return
    await websocket.accept()

    req = _expand(path) if path else ""
    ok = bool(req) and req.lower().endswith(".bat") and os.path.isfile(req) and (_norm(req) in _allowed_keys())
    if not ok:
        await websocket.send_text(json.dumps({
            "type": "error",
            "message": f"Script not allowed or not found: {path}",
        }))
        await websocket.close()
        return

    label = os.path.basename(req)
    await websocket.send_text(json.dumps({"type": "started", "file": label}))
    rid = await events.hub.started(req, label, who)   # đăng ký + quảng bá cho mọi người
    code = None
    try:
        code = await runner.run_bat(websocket, req, os.path.dirname(req), STDIN_LOG)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": f"Runner error: {e}"}))
        except Exception:
            pass
    finally:
        await events.hub.finished(rid, code)         # bỏ khỏi registry + quảng bá kết thúc
        # Đóng socket dứt khoát sau khi tiến trình kết thúc để client về idle ngay.
        try:
            await websocket.close()
        except Exception:
            pass


def _resolve_terminal(cmd: str):
    """Chỉ cho phép adb/fastboot; thay bằng đường dẫn thật. Trả (argv|None, error|None)."""
    try:
        argv = terminal.tokenize(cmd)
    except Exception as e:
        return None, f"parse error: {e}"
    if not argv:
        return None, None
    exe = argv[0].lower()
    if exe == "adb":
        argv[0] = adb.ADB
    elif exe == "fastboot":
        argv[0] = FASTBOOT_PATH
    else:
        return None, f"Only 'adb' and 'fastboot' commands are allowed (got: {argv[0]})."
    return argv, None


@app.websocket("/terminal")
async def ws_terminal(websocket: WebSocket, token: str = Query("")):
    """Terminal chạy lệnh adb / fastboot (không qua shell)."""
    if not AUTH_TOKEN or token != AUTH_TOKEN:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    try:
        await terminal.run_terminal(websocket, _resolve_terminal)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[terminal] kết thúc phiên: {e!r}")


@app.websocket("/logcat")
async def ws_logcat(websocket: WebSocket, token: str = Query(""), serial: str = Query(""), clear: int = Query(0)):
    """Stream logcat về client. Client gửi {"type":"clear"} để xoá buffer và đọc lại."""
    if not AUTH_TOKEN or token != AUTH_TOKEN:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    serial = serial or None

    # cờ điều khiển: đặt True khi client yêu cầu clear -> restart stream với -c.
    restart = {"clear": bool(clear)}

    async def pump_log():
        while True:
            do_clear = restart["clear"]
            restart["clear"] = False
            async for chunk in adb.stream_logcat(serial, clear_first=do_clear):
                await websocket.send_bytes(chunk)
                if restart["clear"]:
                    break  # thoát generator hiện tại để restart với -c
            if not restart["clear"]:
                # generator kết thúc bất thường (mất thiết bị) -> nghỉ rồi thử lại
                await anyio.sleep(1.0)

    async def pump_ctrl():
        while True:
            msg = await websocket.receive_text()
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "clear":
                restart["clear"] = True

    try:
        async with anyio.create_task_group() as tg:
            async def log_task():
                await pump_log()
                tg.cancel_scope.cancel()

            async def ctrl_task():
                await pump_ctrl()
                tg.cancel_scope.cancel()

            tg.start_soon(log_task)
            tg.start_soon(ctrl_task)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[logcat] kết thúc phiên: {e!r}")


@app.websocket("/ws")
async def ws_endpoint(
    websocket: WebSocket,
    token: str = Query(""),
    serial: str = Query(""),
    engine: str = Query("scrcpy"),
    bitrate: int = Query(0),
    maxsize: int = Query(0),
    fps: int = Query(0),
    scrcpy_version: str = Query(""),
):
    # Xác thực trước khi chấp nhận.
    if not AUTH_TOKEN or token != AUTH_TOKEN:
        await websocket.close(code=4401)
        return
    await websocket.accept()

    global WS_CLIENTS
    WS_CLIENTS += 1

    serial = serial or None
    use_bitrate = bitrate if bitrate > 0 else VIDEO_BITRATE

    # Tự đánh thức màn hình mỗi khi có kết nối điều khiển (chỉ bật, không tắt).
    try:
        await adb.wake_screen(serial)
    except Exception:
        pass

    # Lấy kích thước màn hình thật (để map toạ độ chạm).
    try:
        width, height = await adb.get_screen_size(serial)
    except Exception:
        width, height = 1080, 1920

    await websocket.send_text(json.dumps({"type": "meta", "width": width, "height": height}))

    async def pump_video():
        """Lấy H.264 từ engine đã chọn và đẩy nhị phân tới browser."""
        try:
            if engine == "scrcpy":
                # Chọn version: ưu tiên UI gửi lên (nếu hợp lệ), nếu không dùng .env.
                version = scrcpy_version if adb.valid_scrcpy_version(scrcpy_version) else SCRCPY_VERSION
                if not adb.valid_scrcpy_version(version):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": f"Invalid scrcpy version '{version}'. Use a value like 2.4 or 3.1.",
                    }))
                    return

                # Tải scrcpy-server nếu chưa có (báo cho UI biết khi phải tải lần đầu).
                target = adb.scrcpy_target_path(version, SCRCPY_JAR)
                need_dl = not (os.path.exists(target) and os.path.getsize(target) > 1000)
                if need_dl and not SCRCPY_JAR and not SCRCPY_AUTO_DOWNLOAD:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": "scrcpy-server not found and auto-download is disabled "
                                   "(set SCRCPY_AUTO_DOWNLOAD=1 or SCRCPY_SERVER_JAR in .env).",
                    }))
                    return
                if need_dl and not SCRCPY_JAR:
                    await websocket.send_text(json.dumps({
                        "type": "info",
                        "message": f"Downloading scrcpy-server v{version} (first run)…",
                    }))

                try:
                    jar = await adb.ensure_scrcpy_server(version, SCRCPY_JAR, SCRCPY_AUTO_DOWNLOAD)
                except Exception as e:
                    await websocket.send_text(json.dumps({"type": "error", "message": f"scrcpy-server unavailable: {e}"}))
                    return

                gen = adb.stream_h264_scrcpy(
                    serial, version, jar,
                    max_fps=fps, max_size=maxsize, bitrate=use_bitrate,
                )
            else:
                size = adb.compute_size(width, height, maxsize) if maxsize > 0 else VIDEO_SIZE
                gen = adb.stream_h264(serial, use_bitrate, size)

            async for chunk in gen:
                await websocket.send_bytes(chunk)
        except Exception as e:
            try:
                await websocket.send_text(json.dumps({"type": "error", "message": f"Video error: {e}"}))
            except Exception:
                pass

    async def pump_input():
        """Nhận lệnh input dạng JSON từ browser và bơm xuống thiết bị."""
        while True:
            msg = await websocket.receive_text()
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            # Ping/pong để client đo độ trễ vòng (RTT) - echo lại nguyên timestamp.
            if data.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong", "t": data.get("t"), "clients": WS_CLIENTS}))
                continue
            await handle_input(serial, data)

    # Chạy song song; nếu một bên kết thúc/đứt thì huỷ bên còn lại.
    try:
        async with anyio.create_task_group() as tg:
            async def video_task():
                await pump_video()
                tg.cancel_scope.cancel()

            async def input_task():
                await pump_input()
                tg.cancel_scope.cancel()

            tg.start_soon(video_task)
            tg.start_soon(input_task)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[ws] kết thúc phiên: {e!r}")
    finally:
        WS_CLIENTS = max(0, WS_CLIENTS - 1)


async def handle_input(serial, data: dict) -> None:
    t = data.get("type")
    try:
        if t == "tap":
            await adb.input_tap(serial, int(data["x"]), int(data["y"]))
        elif t == "swipe":
            await adb.input_swipe(
                serial,
                int(data["x1"]), int(data["y1"]),
                int(data["x2"]), int(data["y2"]),
                int(data.get("duration", 120)),
            )
        elif t == "text":
            await adb.input_text(serial, str(data.get("text", "")))
        elif t == "keyevent":
            await adb.input_keyevent(serial, int(data["keycode"]))
        elif t == "key":
            # Tên phím (vd "Backspace") -> mã keyevent.
            code = adb.KEYEVENTS.get(str(data.get("name", "")))
            if code is not None:
                await adb.input_keyevent(serial, code)
    except Exception as e:
        print(f"[input] lỗi xử lý {t}: {e!r}")


# Phục vụ file tĩnh khác nếu cần (vd icon).
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    if not AUTH_TOKEN:
        print("CẢNH BÁO: chưa đặt AUTH_TOKEN trong .env - server sẽ từ chối mọi kết nối.")
    print(f"ADB Web Control chạy tại http://{host}:{port}")
    uvicorn.run(app, host=host, port=port)
