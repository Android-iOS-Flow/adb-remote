"""
terminal.py - Terminal web để chạy lệnh adb / fastboot.

An toàn:
- Chỉ chạy executable `adb` hoặc `fastboot` (server quyết định, qua hàm resolve).
- Chạy KHÔNG qua shell (subprocess.Popen với list argv) nên không có chèn lệnh.

Giao thức WebSocket:
  Client -> server: {"type":"run","cmd":"devices"}     # chạy 1 lệnh
                    {"type":"stdin","data":"..."}        # gửi stdin cho lệnh đang chạy
                    {"type":"kill"}                      # dừng lệnh đang chạy
  Server -> client: {"type":"out","data":"..."}          # output (stdout+stderr)
                    {"type":"done","code": <int|null>}    # lệnh kết thúc
"""

import asyncio
import json
import os
import shlex
import subprocess
import threading

from runner import kill_tree


def tokenize(cmd: str) -> list[str]:
    """
    Tách dòng lệnh thành argv, giữ nguyên dấu \\ (đường dẫn Windows) và xử lý nháy.
    """
    lex = shlex.shlex(cmd, posix=True)
    lex.whitespace_split = True
    lex.escape = ""          # không coi \ là ký tự escape -> giữ đường dẫn Windows
    lex.commenters = ""      # không coi # là chú thích
    return list(lex)


def _write_stdin(proc: subprocess.Popen, text: str) -> None:
    try:
        if proc.stdin and proc.poll() is None:
            proc.stdin.write((text + "\r\n").encode("utf-8", "replace"))
            proc.stdin.flush()
    except Exception:
        pass


async def run_terminal(websocket, resolve_cmd) -> None:
    """
    resolve_cmd(cmd) -> (argv|None, error|None):
      - argv: list để Popen (đã thay 'adb'/'fastboot' bằng đường dẫn thật).
      - error: chuỗi lỗi để hiển thị (vd lệnh không được phép); argv khi đó là None.
    """
    loop = asyncio.get_running_loop()
    out_queue: asyncio.Queue = asyncio.Queue()
    state = {"proc": None}

    def spawn(argv):
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )
        state["proc"] = proc

        def reader():
            try:
                while True:
                    data = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                    if not data:
                        break
                    loop.call_soon_threadsafe(
                        out_queue.put_nowait, {"type": "out", "data": data.decode("utf-8", "replace")}
                    )
            except Exception:
                pass
            finally:
                rc = proc.wait()
                state["proc"] = None
                loop.call_soon_threadsafe(out_queue.put_nowait, {"type": "done", "code": rc})

        threading.Thread(target=reader, daemon=True).start()

    async def handle_run(cmd: str):
        argv, err = resolve_cmd(cmd)
        if argv is None:
            if err:
                out_queue.put_nowait({"type": "out", "data": err + "\n"})
                out_queue.put_nowait({"type": "done", "code": None})
            return
        try:
            spawn(argv)
        except Exception as e:
            out_queue.put_nowait({"type": "out", "data": f"cannot run: {e}\n"})
            out_queue.put_nowait({"type": "done", "code": None})

    async def pump_out():
        while True:
            item = await out_queue.get()
            await websocket.send_text(json.dumps(item))

    async def pump_in():
        while True:
            msg = await websocket.receive_text()
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue
            t = data.get("type")
            if t == "run":
                if state["proc"] is not None:
                    out_queue.put_nowait({"type": "out", "data": "[a command is still running]\n"})
                else:
                    await handle_run(str(data.get("cmd", "")))
            elif t == "stdin":
                p = state["proc"]
                if p is not None:
                    await loop.run_in_executor(None, _write_stdin, p, str(data.get("data", "")))
            elif t == "kill":
                kill_tree(state["proc"])

    out_task = asyncio.create_task(pump_out())
    try:
        await pump_in()
    finally:
        out_task.cancel()
        kill_tree(state["proc"])
