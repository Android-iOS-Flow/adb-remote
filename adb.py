"""
adb.py - Các hàm tiện ích bao quanh lệnh adb.

Chịu trách nhiệm:
- Liệt kê thiết bị đang kết nối.
- Lấy kích thước màn hình thật của thiết bị (dùng để map toạ độ chạm).
- Stream video H.264 từ `screenrecord` (encode phần cứng của Android).
- Bơm sự kiện input (tap / swipe / text / keyevent) xuống thiết bị.

Tất cả đều dùng asyncio subprocess để không chặn event loop.
"""

import asyncio
import os
import random
import re
import shlex
import shutil
import socket
import urllib.request
from typing import AsyncIterator, Optional

ADB = os.environ.get("ADB_PATH", "adb")

# screenrecord có giới hạn thời gian tối đa 180 giây mỗi lần chạy.
# Ta tự khởi động lại trước khi hết hạn để stream chạy liên tục.
SEGMENT_SECONDS = 170


def _base_cmd(serial: Optional[str]) -> list[str]:
    cmd = [ADB]
    if serial:
        cmd += ["-s", serial]
    return cmd


async def _run(serial: Optional[str], args: list[str], timeout: float = 15.0) -> tuple[int, bytes, bytes]:
    """Chạy một lệnh adb ngắn, trả về (returncode, stdout, stderr)."""
    proc = await asyncio.create_subprocess_exec(
        *_base_cmd(serial), *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise
    return proc.returncode, out, err


async def list_devices() -> list[dict]:
    """Trả về danh sách thiết bị: [{serial, state, model}]."""
    rc, out, _ = await _run(None, ["devices", "-l"])
    devices = []
    if rc != 0:
        return devices
    for line in out.decode(errors="replace").splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        serial = parts[0]
        state = parts[1] if len(parts) > 1 else "unknown"
        model = ""
        m = re.search(r"model:(\S+)", line)
        if m:
            model = m.group(1)
        devices.append({"serial": serial, "state": state, "model": model})
    return devices


async def probe_device(serial: Optional[str]) -> dict:
    """
    Kiểm tra trạng thái thiết bị để phân biệt rõ các tình huống "không có video":
      - no_device   : adb không thấy thiết bị nào (rút cáp / tắt nguồn / chưa cấp quyền).
      - unauthorized: thiết bị có nhưng chưa "Allow USB debugging".
      - offline     : thiết bị ở trạng thái offline (thường đang khởi động / mất kết nối tạm).
      - booting     : adb thấy 'device' nhưng sys.boot_completed != 1 (đang boot).
      - ready       : đã boot xong, sẵn sàng stream.

    Trả về {state, serial, reason} với reason là mô tả tiếng Việt cho UI.
    """
    devices = await list_devices()
    if serial:
        match = next((d for d in devices if d["serial"] == serial), None)
    else:
        match = devices[0] if devices else None

    if match is None:
        if devices:
            return {"state": "no_device", "serial": serial or "",
                    "reason": "Không tìm thấy thiết bị theo serial đã chọn (có thiết bị khác đang kết nối)."}
        return {"state": "no_device", "serial": serial or "",
                "reason": "Không có thiết bị ADB nào — kiểm tra cáp, nguồn điện thoại, hoặc adb."}

    st = match.get("state", "")
    tgt = match["serial"]
    if st == "unauthorized":
        return {"state": "unauthorized", "serial": tgt,
                "reason": "Thiết bị chưa được cấp quyền — bấm 'Allow USB debugging' trên màn hình điện thoại."}
    if st == "offline":
        return {"state": "offline", "serial": tgt,
                "reason": "Thiết bị đang offline — có thể đang khởi động lại hoặc mất kết nối tạm thời."}
    if st != "device":
        return {"state": st or "unknown", "serial": tgt,
                "reason": f"Thiết bị ở trạng thái '{st or 'unknown'}'."}

    # state == "device": có kết nối, kiểm tra đã boot xong chưa.
    try:
        rc, out, _ = await _run(tgt, ["shell", "getprop", "sys.boot_completed"], timeout=6.0)
        booted = out.decode(errors="replace").strip() == "1"
    except Exception:
        booted = False
    if not booted:
        return {"state": "booting", "serial": tgt,
                "reason": "Đã kết nối ADB nhưng hệ thống chưa khởi động xong (đang boot)."}
    return {"state": "ready", "serial": tgt,
            "reason": "Đã kết nối ADB và thiết bị sẵn sàng."}


def compute_size(width: int, height: int, max_side: int) -> str:
    """
    Tính chuỗi --size cho screenrecord, giữ nguyên tỉ lệ thiết bị.

    max_side = 0  -> trả về "" (độ phân giải gốc).
    Ngược lại scale sao cho cạnh dài nhất == max_side, làm tròn về số chẵn.
    """
    if max_side <= 0:
        return ""
    longest = max(width, height)
    if longest <= max_side:
        return ""  # đã nhỏ hơn yêu cầu, dùng gốc
    ratio = max_side / longest
    nw = max(2, round(width * ratio / 2) * 2)
    nh = max(2, round(height * ratio / 2) * 2)
    return f"{nw}x{nh}"


async def get_screen_size(serial: Optional[str]) -> tuple[int, int]:
    """Lấy kích thước màn hình thật (width, height). Mặc định 1080x1920 nếu thất bại."""
    rc, out, _ = await _run(serial, ["shell", "wm", "size"])
    text = out.decode(errors="replace")
    # Ưu tiên "Override size" nếu có, sau đó "Physical size".
    override = re.search(r"Override size:\s*(\d+)x(\d+)", text)
    physical = re.search(r"Physical size:\s*(\d+)x(\d+)", text)
    chosen = override or physical
    if chosen:
        return int(chosen.group(1)), int(chosen.group(2))
    return 1080, 1920


async def stream_h264(serial: Optional[str], bitrate: int, size: str = "") -> AsyncIterator[bytes]:
    """
    Sinh ra các chunk byte H.264 (Annex-B elementary stream) liên tục.

    screenrecord tự thoát sau ~180s, nên ta lặp khởi động lại. Mỗi segment mới
    bắt đầu bằng SPS/PPS + IDR nên trình duyệt có thể tiếp tục decode.
    """
    while True:
        args = [
            "exec-out", "screenrecord",
            "--output-format=h264",
            f"--bit-rate={bitrate}",
            f"--time-limit={SEGMENT_SECONDS}",
        ]
        if size:
            args.append(f"--size={size}")
        args.append("-")  # xuất ra stdout

        proc = await asyncio.create_subprocess_exec(
            *_base_cmd(serial), *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(16384)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
        # Vòng lặp tiếp tục: khởi động segment screenrecord mới.


# ---------------------------------------------------------------------------
# Engine scrcpy-server (hỗ trợ max_fps, độ trễ thấp)
# ---------------------------------------------------------------------------

SCRCPY_REMOTE = "/data/local/tmp/scrcpy-server.jar"
_VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")


def valid_scrcpy_version(version: str) -> bool:
    """Chỉ cho phép version dạng số + dấu chấm (vd 2.4, 3.1) để tránh inject."""
    return bool(version) and bool(_VERSION_RE.match(version))


def _scrcpy_cache_dir() -> str:
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
    os.makedirs(d, exist_ok=True)
    return d


def scrcpy_target_path(version: str, explicit_path: str = "") -> str:
    """Đường dẫn file scrcpy-server sẽ dùng (ưu tiên explicit_path từ .env)."""
    if explicit_path:
        return explicit_path
    return os.path.join(_scrcpy_cache_dir(), f"scrcpy-server-v{version}")


def scrcpy_download_url(version: str) -> str:
    return f"https://github.com/Genymobile/scrcpy/releases/download/v{version}/scrcpy-server-v{version}"


def _download(url: str, dest: str) -> None:
    """Tải file (chặn) - gọi qua asyncio.to_thread."""
    req = urllib.request.Request(url, headers={"User-Agent": "adb-web-control"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)


async def ensure_scrcpy_server(version: str, explicit_path: str = "", auto_download: bool = True) -> str:
    """
    Bảo đảm có file scrcpy-server và trả về đường dẫn của nó.

    - Nếu explicit_path (.env SCRCPY_SERVER_JAR) tồn tại -> dùng luôn.
    - Nếu đã tải sẵn trong vendor/ -> dùng lại.
    - Nếu chưa có và auto_download -> tải đúng scrcpy-server-v{version} từ GitHub.

    version PHẢI hợp lệ (đã kiểm tra bằng valid_scrcpy_version trước khi gọi).
    """
    if explicit_path:
        if os.path.exists(explicit_path) and os.path.getsize(explicit_path) > 1000:
            return explicit_path
        raise RuntimeError(f"SCRCPY_SERVER_JAR not found: {explicit_path}")

    dest = scrcpy_target_path(version)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return dest

    if not auto_download:
        raise RuntimeError("scrcpy-server not found and auto-download is disabled.")

    url = scrcpy_download_url(version)
    tmp = dest + ".part"
    try:
        await asyncio.to_thread(_download, url, tmp)
    except Exception as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError(f"Download failed from {url}: {e}")

    if not os.path.exists(tmp) or os.path.getsize(tmp) < 1000:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise RuntimeError(f"Downloaded file invalid (too small). Check version '{version}'. URL: {url}")
    os.replace(tmp, dest)
    return dest


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


async def stream_h264_scrcpy(
    serial: Optional[str],
    version: str,
    jar_path: str,
    max_fps: int = 0,
    max_size: int = 0,
    bitrate: int = 8_000_000,
) -> AsyncIterator[bytes]:
    """
    Stream H.264 (Annex-B) bằng scrcpy-server.

    Chỉ dùng socket video (control=false, audio=false, raw_stream=true) nên
    luồng là H.264 thuần, tái dùng được bộ giải mã WebCodecs phía trình duyệt.
    Input vẫn đi qua `adb shell input` (xem các hàm input_* bên dưới).

    Lưu ý: `version` PHẢI khớp đúng với file scrcpy-server đã tải.
    """
    # 1) Đẩy scrcpy-server lên thiết bị.
    rc, _, err = await _run(serial, ["push", jar_path, SCRCPY_REMOTE], timeout=30)
    if rc != 0:
        raise RuntimeError(f"push scrcpy-server failed: {err.decode(errors='replace').strip()}")

    # 2) Tạo socket name + adb forward.
    scid = "%08x" % random.randint(1, 0x7FFFFFFF)
    sock_name = f"localabstract:scrcpy_{scid}"
    port = _free_port()
    rc, _, err = await _run(serial, ["forward", f"tcp:{port}", sock_name])
    if rc != 0:
        raise RuntimeError(f"adb forward failed: {err.decode(errors='replace').strip()}")

    # 3) Khởi động scrcpy-server.
    opts = [
        f"scid={scid}",
        "log_level=info",
        "audio=false",
        "control=false",
        "tunnel_forward=true",
        "raw_stream=true",
        "cleanup=true",
        f"max_size={max_size if max_size else 0}",
        f"video_bit_rate={bitrate}",
    ]
    if max_fps:
        opts.append(f"max_fps={max_fps}")

    server_cmd = _base_cmd(serial) + [
        "shell",
        f"CLASSPATH={SCRCPY_REMOTE}",
        "app_process", "/", "com.genymobile.scrcpy.Server", version,
    ] + opts

    server_proc = await asyncio.create_subprocess_exec(
        *server_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    print("[scrcpy] start:", " ".join(server_cmd[len(_base_cmd(serial)):]))

    reader = writer = None
    loop = asyncio.get_running_loop()
    first_chunk = b""
    try:
        # 4) Kết nối + XÁC NHẬN server đã sẵn sàng.
        # Ở chế độ tunnel_forward, adb chấp nhận TCP ngay rồi mới thử mở socket
        # scrcpy trên thiết bị; nếu socket chưa tồn tại, adb đóng kết nối -> biểu
        # hiện là EOF tức thì. Vì vậy phải đọc thử chunk đầu; EOF thì thử lại.
        deadline = loop.time() + 8.0
        while True:
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                first_chunk = await reader.read(16384)
                if first_chunk:
                    break  # đã nhận dữ liệu -> server thật sự sẵn sàng
                # EOF: chưa sẵn sàng -> đóng và thử lại
                try:
                    writer.close()
                except Exception:
                    pass
                reader = writer = None
            except OSError:
                pass

            if loop.time() > deadline or server_proc.returncode is not None:
                serr = b""
                if server_proc.stderr is not None:
                    try:
                        serr = await asyncio.wait_for(server_proc.stderr.read(4000), 0.8)
                    except asyncio.TimeoutError:
                        pass
                raise RuntimeError(
                    "Cannot start scrcpy video stream. "
                    "Kiểm tra version có khớp file scrcpy-server, thiết bị còn kết nối, "
                    "và scrcpy hỗ trợ thiết bị. "
                    f"server log: {serr.decode(errors='replace').strip() or '(empty)'}"
                )
            await asyncio.sleep(0.2)

        # 5) Đẩy chunk đầu rồi tiếp tục đọc H.264 thuần.
        print(f"[scrcpy] stream started ({len(first_chunk)} bytes first chunk)")
        yield first_chunk
        while True:
            chunk = await reader.read(16384)
            if not chunk:
                break
            yield chunk
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass
        if server_proc.returncode is None:
            try:
                server_proc.kill()
            except ProcessLookupError:
                pass
            await server_proc.wait()
        await _run(serial, ["forward", "--remove", f"tcp:{port}"], timeout=5)


# ---------------------------------------------------------------------------
# Logcat
# ---------------------------------------------------------------------------

_LEVELS = "VDIWEF"


async def get_pids(serial: Optional[str], package: str) -> list[str]:
    """Lấy danh sách PID của một package (rỗng nếu app không chạy / không có pidof)."""
    if not package:
        return []
    rc, out, _ = await _run(serial, ["shell", "pidof", package], timeout=10)
    if rc != 0:
        return []
    return out.decode(errors="replace").split()


def _logcat_args(level: str, pids: list[str], dump: bool) -> list[str]:
    args = ["logcat", "-v", "threadtime"]
    if dump:
        args.append("-d")              # dump rồi thoát
    else:
        args += ["-T", "200"]          # bắt đầu với 200 dòng gần nhất rồi follow
    for pid in pids:
        args.append(f"--pid={pid}")
    lv = (level or "").upper()
    if len(lv) == 1 and lv in _LEVELS:
        args.append(f"*:{lv}")         # filterspec: chỉ lấy >= mức này
    return args


async def stream_logcat(serial: Optional[str], level: str = "", package: str = "") -> AsyncIterator[str]:
    """Stream logcat theo dòng (đã lọc mức ưu tiên & PID phía thiết bị)."""
    pids = await get_pids(serial, package) if package else []
    if package and not pids:
        yield f"[no running process for package: {package}]\n"
        return
    args = _logcat_args(level, pids, dump=False)
    proc = await asyncio.create_subprocess_exec(
        *_base_cmd(serial), *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            yield line.decode("utf-8", "replace")
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()


async def dump_logcat(serial: Optional[str], level: str = "", package: str = "") -> str:
    """Dump toàn bộ logcat hiện có (để tải ra file)."""
    pids = await get_pids(serial, package) if package else []
    if package and not pids:
        return f"[no running process for package: {package}]\n"
    args = _logcat_args(level, pids, dump=True)
    rc, out, err = await _run(serial, args, timeout=60)
    text = out.decode("utf-8", "replace")
    if rc != 0 and not text:
        text = f"[logcat error] {err.decode(errors='replace').strip()}"
    return text


# ---------------------------------------------------------------------------
# Logcat streaming
# ---------------------------------------------------------------------------

async def stream_logcat(serial: Optional[str], clear_first: bool = False) -> AsyncIterator[bytes]:
    """
    Stream logcat theo dòng (định dạng threadtime).

    clear_first=True -> xoá buffer log trước khi đọc (adb logcat -c).
    Trả về từng đoạn bytes; client tự tách dòng và lọc.
    """
    if clear_first:
        try:
            await _run(serial, ["logcat", "-c"], timeout=10)
        except Exception:
            pass

    proc = await asyncio.create_subprocess_exec(
        *_base_cmd(serial), "logcat", "-v", "threadtime",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(8192)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()


# ---------------------------------------------------------------------------
# Input injection
# ---------------------------------------------------------------------------

async def wake_screen(serial: Optional[str]) -> None:
    """Đánh thức màn hình (KEYCODE_WAKEUP=224 chỉ bật, không bao giờ tắt)."""
    await _run(serial, ["shell", "input", "keyevent", "224"], timeout=10)


async def input_tap(serial: Optional[str], x: int, y: int) -> None:
    await _run(serial, ["shell", "input", "tap", str(x), str(y)], timeout=10)


async def input_swipe(serial: Optional[str], x1: int, y1: int, x2: int, y2: int, duration_ms: int = 120) -> None:
    await _run(
        serial,
        ["shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration_ms)],
        timeout=10,
    )


async def input_text(serial: Optional[str], text: str) -> None:
    # `input text` không chấp nhận khoảng trắng trực tiếp; dùng %s cho dấu cách.
    safe = text.replace(" ", "%s")
    # Bọc trong dấu nháy đơn để shell trên thiết bị không tách chuỗi.
    await _run(serial, ["shell", "input", "text", shlex.quote(safe)], timeout=10)


# Bảng phím đặc biệt -> mã keyevent của Android.
KEYEVENTS = {
    "Backspace": 67,
    "Enter": 66,
    "Tab": 61,
    "Escape": 4,        # BACK
    "ArrowUp": 19,
    "ArrowDown": 20,
    "ArrowLeft": 21,
    "ArrowRight": 22,
    "Home": 3,          # HOME
    "AppSwitch": 187,   # recent apps
    "VolumeUp": 24,
    "VolumeDown": 25,
    "Power": 26,
}


async def input_keyevent(serial: Optional[str], keycode: int) -> None:
    await _run(serial, ["shell", "input", "keyevent", str(keycode)], timeout=10)


# ---------------------------------------------------------------------------
# Quản lý file (duyệt / tải / upload / mkdir / xoá / đổi tên)
# ---------------------------------------------------------------------------
#
# Mọi path gửi xuống `adb shell` đều được bọc bằng shlex.quote để tránh inject
# và để xử lý đúng tên có khoảng trắng / ký tự đặc biệt. `adb pull` / `adb push`
# nhận path qua argv (không qua shell trên máy chủ) nên an toàn sẵn.


def _q(path: str) -> str:
    """Bọc path cho shell trên thiết bị (an toàn với khoảng trắng / ký tự lạ)."""
    return shlex.quote(path)


def normalize_remote(path: str) -> str:
    """
    Chuẩn hoá path POSIX trên thiết bị: gộp '//', xử lý '.' và '..', luôn tuyệt đối.

    Không đụng tới hệ thống file máy chủ - chỉ xử lý chuỗi.
    """
    if not path:
        return "/sdcard"
    path = path.replace("\\", "/")
    if not path.startswith("/"):
        path = "/" + path
    parts = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return "/" + "/".join(parts)


# Phân tích một dòng output của `ls -lA` (định dạng toybox/Android).
#   drwxrwx--x 4 root sdcard_rw 3452 2024-01-02 11:22 DCIM
#   -rw-rw---- 1 root sdcard_rw  123 2024-01-02 11:22 file name.txt
#   lrwxrwxrwx 1 root root        21 ... self -> /storage/self/primary
_LS_RE = re.compile(
    r"^(?P<perm>[bcdlsp-][rwxsStT-]{9})\s+"
    r"\d+\s+\S+\s+\S+\s+"
    r"(?P<size>\d+)\s+"
    r"(?P<date>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+"
    r"(?P<name>.+)$"
)


def _parse_ls_line(line: str) -> Optional[dict]:
    line = line.rstrip("\r\n")
    if not line or line.startswith("total "):
        return None
    m = _LS_RE.match(line)
    if not m:
        return None
    perm = m.group("perm")
    name = m.group("name")
    typ = perm[0]
    is_dir = typ == "d"
    is_link = typ == "l"
    target = ""
    if is_link and " -> " in name:
        name, target = name.split(" -> ", 1)
    if name in (".", ".."):
        return None
    return {
        "name": name,
        "is_dir": is_dir,
        "is_link": is_link,
        "link_target": target,
        "size": int(m.group("size")),
        "perm": perm,
        "mtime": m.group("date"),
    }


async def list_dir(serial: Optional[str], path: str) -> dict:
    """
    Liệt kê nội dung thư mục trên thiết bị.

    Trả về {"path", "entries":[...], "error"?}. Mỗi entry có:
    name, is_dir, is_link, link_target, size, perm, mtime.

    Với symlink, ta thử dò xem nó có trỏ tới thư mục không (để duyệt tiếp được).
    """
    path = normalize_remote(path)
    # -L không dùng để giữ thông tin symlink; -A bỏ . và .. ; --color=never tránh mã màu.
    rc, out, err = await _run(serial, ["shell", f"ls -lA {_q(path)}"], timeout=20)
    text = out.decode("utf-8", "replace")
    etext = err.decode("utf-8", "replace").strip()
    entries = []
    for line in text.splitlines():
        ent = _parse_ls_line(line)
        if ent:
            entries.append(ent)
    # Một số lỗi (No such file, Permission denied) in ra stderr lẫn stdout.
    err_msg = ""
    low = (text + " " + etext).lower()
    if not entries and ("no such file" in low or "permission denied" in low or "not a directory" in low):
        err_msg = etext or text.strip() or "Không truy cập được."
    # Phân giải symlink -> thư mục: thử `ls -d` mục tiêu (nhẹ nhàng, không bắt buộc).
    links = [e for e in entries if e["is_link"]]
    for e in links:
        child = path.rstrip("/") + "/" + e["name"]
        rc2, out2, _ = await _run(serial, ["shell", f"ls -ld {_q(child)}/"], timeout=10)
        if rc2 == 0 and out2.decode("utf-8", "replace").strip().startswith("d"):
            e["is_dir"] = True
    # Sắp xếp: thư mục trước, rồi theo tên (không phân biệt hoa thường).
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"path": path, "entries": entries, "error": err_msg}


async def stat_remote(serial: Optional[str], path: str) -> dict:
    """Lấy thông tin một path (tồn tại / là thư mục / kích thước)."""
    path = normalize_remote(path)
    rc, out, _ = await _run(serial, ["shell", f"ls -ldA {_q(path)}"], timeout=10)
    text = out.decode("utf-8", "replace").strip()
    exists = rc == 0 and bool(text) and "no such file" not in text.lower()
    is_dir = text.startswith("d") if exists else False
    return {"path": path, "exists": exists, "is_dir": is_dir}


async def mkdir_remote(serial: Optional[str], path: str) -> tuple[bool, str]:
    path = normalize_remote(path)
    rc, _, err = await _run(serial, ["shell", f"mkdir -p {_q(path)}"], timeout=15)
    return rc == 0, err.decode("utf-8", "replace").strip()


async def remove_remote(serial: Optional[str], path: str) -> tuple[bool, str]:
    """Xoá file hoặc thư mục (đệ quy). Path tuyệt đối, chặn xoá gốc '/'."""
    path = normalize_remote(path)
    if path == "/" or not path:
        return False, "Từ chối: không thể xoá thư mục gốc."
    rc, _, err = await _run(serial, ["shell", f"rm -rf {_q(path)}"], timeout=30)
    return rc == 0, err.decode("utf-8", "replace").strip()


async def move_remote(serial: Optional[str], src: str, dst: str) -> tuple[bool, str]:
    src = normalize_remote(src)
    dst = normalize_remote(dst)
    if src in ("/", ""):
        return False, "Nguồn không hợp lệ."
    rc, _, err = await _run(serial, ["shell", f"mv -f {_q(src)} {_q(dst)}"], timeout=30)
    return rc == 0, err.decode("utf-8", "replace").strip()


async def push_file(serial: Optional[str], local_path: str, remote_path: str) -> tuple[bool, str]:
    """Đẩy 1 file từ máy chủ lên thiết bị (adb push, không qua shell)."""
    remote_path = normalize_remote(remote_path)
    rc, out, err = await _run(serial, ["push", local_path, remote_path], timeout=600)
    msg = (err.decode("utf-8", "replace") + out.decode("utf-8", "replace")).strip()
    return rc == 0, msg


async def stream_pull(serial: Optional[str], path: str) -> AsyncIterator[bytes]:
    """
    Stream nội dung 1 file từ thiết bị về (dùng `exec-out cat`).

    Hợp với việc cho trình duyệt tải trực tiếp mà không cần lưu tạm trên máy chủ.
    Lưu ý: chỉ dùng cho FILE (không phải thư mục) - kiểm tra trước khi gọi.
    """
    path = normalize_remote(path)
    proc = await asyncio.create_subprocess_exec(
        *_base_cmd(serial), "exec-out", f"cat {_q(path)}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert proc.stdout is not None
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
