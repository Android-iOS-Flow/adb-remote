"""
runner.py - Chạy file .bat và stream log hai chiều qua WebSocket.

Vì uvicorn trên Windows có thể dùng event loop không hỗ trợ asyncio subprocess
pipe, ta chạy tiến trình bằng subprocess.Popen trong một thread riêng và bắc cầu
dữ liệu về event loop qua asyncio.Queue + call_soon_threadsafe. Cách này chạy ổn
định bất kể loop nào.

Giao thức WebSocket:
  Server -> client: {"type":"out","data": "..."}     # log (stdout+stderr)
                    {"type":"exit","code": <int>}     # tiến trình kết thúc
                    {"type":"error","message": "..."} # không chạy được
  Client -> server: {"type":"stdin","data":"..."}     # gửi 1 dòng xuống stdin
                    {"type":"kill"}                    # dừng tiến trình
"""

import asyncio
import datetime
import json
import os
import subprocess
import threading

from fastapi import WebSocket, WebSocketDisconnect

_log_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Windows Job Object: gom CMD.EXE và TẤT CẢ tiến trình con (kể cả tiến trình
# tách rời bằng `start`) vào một "job". Khi gọi TerminateJobObject hoặc đóng
# handle của job (KILL_ON_JOB_CLOSE), toàn bộ cây tiến trình bị giết một lượt.
#
# Vì sao cần job thay vì taskkill /T:
#   - taskkill /T đi theo quan hệ cha→con (PPID). Khi một tiến trình trung gian
#     thoát sớm (rất hay gặp: .bat dùng `start` rồi cmd.exe thoát ngay), các
#     tiến trình cháu bị "mồ côi" và taskkill không còn lần ra được.
#   - Job Object ràng buộc theo "thành viên job", không phụ thuộc PPID, nên giết
#     được kể cả khi cmd.exe đã thoát.
#
# Khối ctypes chỉ nạp trên Windows; trên hệ khác mọi thứ là None để file vẫn
# import được bình thường (phục vụ kiểm thử / chạy thử ngoài Windows).
# ---------------------------------------------------------------------------
_JOB_OK = False
if os.name == "nt":
    try:
        import ctypes
        from ctypes import wintypes

        _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
        _JobObjectExtendedLimitInformation = 9

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),  # ULONG_PTR
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        _kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        _kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        _kernel32.SetInformationJobObject.restype = wintypes.BOOL
        _kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        ]
        _kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        _kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        _kernel32.TerminateJobObject.restype = wintypes.BOOL
        _kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        _kernel32.CloseHandle.restype = wintypes.BOOL
        _kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        # --- API phục vụ tạo tiến trình "suspended" rồi resume sau khi gán job ---
        # Mục đích: gán cmd.exe vào job KHI NÓ CHƯA CHẠY (chưa sinh tiến trình con
        # nào), nên mọi tiến trình .bat tạo ra sau này chắc chắn nằm trong job ->
        # đóng hẳn khe hở "con thoát khỏi job" khiến Stop trước đây không ăn.
        CREATE_SUSPENDED = 0x00000004
        THREAD_SUSPEND_RESUME = 0x0002
        TH32CS_SNAPTHREAD = 0x00000004

        class _THREADENTRY32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ThreadID", wintypes.DWORD),
                ("th32OwnerProcessID", wintypes.DWORD),
                ("tpBasePri", ctypes.c_long),
                ("tpDeltaPri", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
            ]

        _kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        _kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        _kernel32.Thread32First.restype = wintypes.BOOL
        _kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(_THREADENTRY32)]
        _kernel32.Thread32Next.restype = wintypes.BOOL
        _kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(_THREADENTRY32)]
        _kernel32.OpenThread.restype = wintypes.HANDLE
        _kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        _kernel32.ResumeThread.restype = wintypes.DWORD
        _kernel32.ResumeThread.argtypes = [wintypes.HANDLE]

        _JOB_OK = True
    except Exception:
        _JOB_OK = False


def _resume_process(pid: int) -> bool:
    """
    Đánh thức (resume) mọi luồng của tiến trình `pid`.

    Tiến trình vừa tạo bằng CREATE_SUSPENDED có đúng một luồng chính đang bị
    treo; ta liệt kê luồng qua Toolhelp snapshot rồi ResumeThread. Trả True nếu
    đã resume được ít nhất một luồng.
    """
    if not _JOB_OK:
        return False
    INVALID = wintypes.HANDLE(-1).value
    snap = _kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if not snap or snap == INVALID:
        return False
    try:
        entry = _THREADENTRY32()
        entry.dwSize = ctypes.sizeof(_THREADENTRY32)
        ok = _kernel32.Thread32First(snap, ctypes.byref(entry))
        resumed = False
        while ok:
            if entry.th32OwnerProcessID == pid:
                h = _kernel32.OpenThread(THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                if h:
                    _kernel32.ResumeThread(h)
                    _kernel32.CloseHandle(h)
                    resumed = True
            ok = _kernel32.Thread32Next(snap, ctypes.byref(entry))
        return resumed
    except Exception:
        return False
    finally:
        _kernel32.CloseHandle(snap)


def _create_job():
    """Tạo Job Object đặt cờ KILL_ON_JOB_CLOSE. Trả handle (int) hoặc None."""
    if not _JOB_OK:
        return None
    try:
        job = _kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = _kernel32.SetInformationJobObject(
            job, _JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info),
        )
        if not ok:
            _kernel32.CloseHandle(job)
            return None
        return job
    except Exception:
        return None


def _assign_to_job(job, proc: "subprocess.Popen") -> bool:
    """Gán tiến trình vào job. Trả True nếu thành công."""
    if not _JOB_OK or not job or proc is None:
        return False
    try:
        # proc._handle là HANDLE tiến trình do CreateProcess trả về (đủ quyền
        # PROCESS_SET_QUOTA | PROCESS_TERMINATE để gán job).
        return bool(_kernel32.AssignProcessToJobObject(job, int(proc._handle)))
    except Exception:
        return False


def _terminate_job(job) -> None:
    if not _JOB_OK or not job:
        return
    try:
        _kernel32.TerminateJobObject(job, 1)
    except Exception:
        pass


def _close_job(job) -> None:
    # Đóng handle cuối cùng -> KILL_ON_JOB_CLOSE giết nốt mọi tiến trình còn sót.
    if not _JOB_OK or not job:
        return
    try:
        _kernel32.CloseHandle(job)
    except Exception:
        pass


def _append_log(log_path: str, script: str, text: str) -> None:
    """Ghi một dòng stdin vào file log (timestamp \\t script \\t nội dung)."""
    if not log_path:
        return
    try:
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"{ts}\t{script}\t{text}\n"
        with _log_lock:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass


def _spawn(path: str, cwd: str):
    """
    Tạo tiến trình chạy .bat và (trên Windows) gắn nó vào một Job Object.

    Trả về (proc, job) - job có thể là None nếu không tạo được (hệ không phải
    Windows, hoặc API job thất bại); khi đó kill_tree tự rơi về taskkill /T.
    """
    if os.name == "nt":
        cmd = ["cmd.exe", "/c", path]
    else:
        # Không phải Windows: .bat không chạy được, nhưng vẫn thử để báo lỗi rõ ràng.
        cmd = [path]

    job = _create_job()  # None nếu ngoài Windows / không khả dụng

    # Khi có job, tạo cmd.exe ở trạng thái SUSPENDED để gán job TRƯỚC khi nó kịp
    # chạy dòng .bat đầu tiên. Nhờ vậy không còn khe hở: mọi tiến trình con/cháu
    # (kể cả tiến trình adb/fastboot tách rời) đều sinh ra BÊN TRONG job, nên một
    # lần TerminateJobObject là giết sạch cây từ gốc.
    creationflags = CREATE_SUSPENDED if (os.name == "nt" and job is not None) else 0
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
        creationflags=creationflags,
    )

    if job is not None:
        assigned = _assign_to_job(job, proc)
        if creationflags:  # đã tạo ở trạng thái suspended -> cần resume
            # Luôn đánh thức tiến trình, bất kể gán job thành công hay không, để
            # nó không bao giờ bị treo vĩnh viễn ở trạng thái suspended.
            if not _resume_process(proc.pid):
                # Không resume được (rất hiếm): không để lại tiến trình treo.
                # Giết nó rồi tạo lại theo cách thường (chấp nhận khe hở nhỏ +
                # fallback taskkill /T) còn hơn để treo.
                try:
                    kill_tree(proc, job if assigned else None)
                except Exception:
                    pass
                _close_job(job)
                proc = subprocess.Popen(
                    cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT, bufsize=0,
                )
                job = _create_job()
                if job is not None and not _assign_to_job(job, proc):
                    _close_job(job)
                    job = None
                return proc, job
        # Gán thất bại (hiếm - vd cmd.exe ở trong job cấm lồng): bỏ job, để
        # taskkill /T lo phần còn lại.
        if not assigned:
            _close_job(job)
            job = None

    return proc, job


def kill_tree(proc: subprocess.Popen, job=None) -> None:
    """
    Dừng tiến trình gốc VÀ toàn bộ tiến trình con (kể cả tiến trình tách rời).

    Thứ tự ưu tiên:
      1) TerminateJobObject(job): giết mọi thành viên job một lượt. Cách này
         hoạt động NGAY CẢ KHI cmd.exe gốc đã thoát (vd .bat dùng `start` khiến
         cmd.exe kết thúc sớm còn tiến trình con vẫn chạy) - đây chính là lý do
         taskkill /T trước đây "bấm Stop không ăn".
      2) taskkill /F /T /PID: fallback khi không có job (gán job thất bại) hoặc
         để chắc chắn dọn sạch cây của cmd.exe.

    LƯU Ý: KHÔNG bỏ qua chỉ vì proc.poll() != None. cmd.exe có thể đã thoát
    trong khi tiến trình con vẫn sống trong job.
    """
    # 1) Giết cả job trước (không phụ thuộc cmd.exe còn sống hay không).
    _terminate_job(job)

    # 2) Fallback taskkill cho chính cmd.exe nếu nó còn chạy.
    if proc is not None and proc.poll() is None:
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    capture_output=True, timeout=10,
                )
            else:
                proc.terminate()
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass


def _write_stdin(proc: subprocess.Popen, text: str) -> None:
    try:
        if proc.stdin and proc.poll() is None:
            proc.stdin.write((text + "\r\n").encode("utf-8", "replace"))
            proc.stdin.flush()
    except Exception:
        pass


async def run_bat(websocket: WebSocket, path: str, cwd: str, log_path: str = "") -> None:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    script_name = os.path.basename(path)

    try:
        proc, job = _spawn(path, cwd)
    except Exception as e:
        await websocket.send_text(json.dumps({"type": "error", "message": f"Cannot run: {e}"}))
        return

    def reader() -> None:
        """Đọc output trong thread, đẩy về loop qua queue."""
        try:
            assert proc.stdout is not None
            while True:
                data = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                if not data:
                    break
                loop.call_soon_threadsafe(queue.put_nowait, ("out", data))
        except Exception:
            pass
        finally:
            rc = proc.wait()
            loop.call_soon_threadsafe(queue.put_nowait, ("exit", rc))

    threading.Thread(target=reader, daemon=True).start()

    async def pump_in() -> None:
        try:
            while True:
                msg = await websocket.receive_text()
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                t = data.get("type")
                if t == "stdin":
                    text = str(data.get("data", ""))
                    _append_log(log_path, script_name, text)  # ghi nhật ký lệnh stdin
                    await loop.run_in_executor(None, _write_stdin, proc, text)
                elif t == "kill":
                    kill_tree(proc, job)
        except (WebSocketDisconnect, RuntimeError):
            pass

    in_task = asyncio.create_task(pump_in())
    exit_code = None
    try:
        while True:
            kind, payload = await queue.get()
            if kind == "out":
                await websocket.send_text(json.dumps({
                    "type": "out",
                    "data": payload.decode("utf-8", "replace"),
                }))
            else:  # exit
                exit_code = payload
                await websocket.send_text(json.dumps({"type": "exit", "code": payload}))
                break
    finally:
        in_task.cancel()
        kill_tree(proc, job)
        # Đóng handle job: với KILL_ON_JOB_CLOSE, mọi tiến trình con còn sót lại
        # (vd tiến trình `start` tách rời) bị giết khi phiên kết thúc -> không
        # để lại tiến trình mồ côi sau khi script chạy xong hoặc đóng tab.
        _close_job(job)
    return exit_code
