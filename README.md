# ADB Web Control

Điều khiển điện thoại Android từ xa qua trình duyệt: xem màn hình real-time + chạm/vuốt/gõ phím. Backend Python (FastAPI). Có **2 engine video**: `scrcpy` (độ trễ thấp + giới hạn FPS) và `screenrecord` (không cần cài thêm gì). Giao diện web bằng tiếng Anh.

## Cách hoạt động

```
Trình duyệt  ──WebSocket──▶  server.py  ──adb──▶  Điện thoại Android
   │  ◀── H.264 (binary) ── scrcpy-server / screenrecord ──┘
   │  ── JSON input (tap/swipe/text/key) ──▶  adb shell input
```

- **Video — engine `scrcpy`:** đẩy `scrcpy-server` lên máy, chạy ở chế độ `raw_stream` (chỉ video, có `max_fps`, `max_size`, `video_bit_rate`), client kết nối qua `adb forward`. Độ trễ thấp hơn nhiều và **giới hạn FPS được thật sự**.
- **Video — engine `screenrecord`:** `adb exec-out screenrecord --output-format=h264` — không cần file phụ, nhưng không cap được FPS và trễ cao hơn.
- **Decode:** trình duyệt giải mã H.264 bằng **WebCodecs** (`VideoDecoder`, tăng tốc phần cứng), vẽ lên `<canvas>`.
- **Input:** click/chạm → `adb shell input tap|swipe`, bàn phím → `input text|keyevent` (dùng chung cho cả hai engine).
- **Tự kết nối lại:** khi mất kết nối ngoài ý muốn (rút cáp, thiết bị ngủ…), client tự quét lại `/api/devices` và kết nối lại với backoff 1→8s, cho tới khi thiết bị quay lại. Bấm **Disconnect** thủ công thì không tự nối lại.

## Yêu cầu

- Python 3.10+
- `adb` (Android Platform Tools) trong PATH, hoặc đặt `ADB_PATH` trong `.env`.
- Điện thoại đã bật **USB debugging** (hoặc Wireless debugging) và được `adb` cho phép (`adb devices` thấy `device`).
- Trình duyệt hỗ trợ **WebCodecs**: Chrome/Edge 94+ (khuyến nghị). Firefox cần bản mới; Safari 17+.

## Cài đặt & chạy

```bash
cd adb-web-control
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt

# Tạo cấu hình
copy .env.example .env        # Windows
# cp .env.example .env        # macOS/Linux
# -> Mở .env, ĐỔI AUTH_TOKEN thành chuỗi bí mật của bạn.

# Kết nối điện thoại, kiểm tra:
adb devices

# Chạy server
python server.py
```

Mở `http://127.0.0.1:8000`, nhập **token**, bấm **Load** để chọn thiết bị, rồi **Connect**. Token và cài đặt được lưu trong trình duyệt (localStorage) nên lần sau tự điền và tự kết nối lại.

Màn hình điện thoại được **tự động đánh thức mỗi khi có kết nối điều khiển** — dùng `KEYCODE_WAKEUP` nên chỉ bật, không bao giờ tắt màn hình.

## Bật engine scrcpy (khuyến nghị, để có FPS + độ trễ thấp)

Engine `scrcpy` cần file `scrcpy-server`, nhưng **không phải tải thủ công** — app sẽ tự tải khi bạn dùng lần đầu.

1. Trong UI chọn **Engine = scrcpy** (mặc định), đặt **scrcpy version** (mặc định `2.4`), kéo **Max FPS**.
2. Lần đầu kết nối, server tự tải `scrcpy-server-v<version>` từ GitHub release vào thư mục `vendor/` (overlay hiện "Downloading scrcpy-server…"). Các lần sau dùng lại file đã tải.
3. Vì tải đúng `scrcpy-server-v<version>` và truyền đúng version đó, **không còn lo lệch phiên bản**.

Cấu hình liên quan trong `.env` (đều tuỳ chọn):

```
SCRCPY_VERSION=2.4         # version mặc định để tải (UI có thể ghi đè)
SCRCPY_AUTO_DOWNLOAD=1     # 1=tự tải, 0=tắt
SCRCPY_SERVER_JAR=         # để trống = auto-download; hoặc trỏ file tự cung cấp
```

Đổi version trong ô **scrcpy version** ở UI là tải bản tương ứng. Nếu máy không ra Internet được, đặt `SCRCPY_AUTO_DOWNLOAD=0` và trỏ `SCRCPY_SERVER_JAR` tới file bạn tự chép vào.

Nếu không muốn dùng scrcpy, chọn **Engine = screenrecord** để chạy ngay, không cần gì thêm.

## Chất lượng & tốc độ

Trong menu trái, mục **Video**:

- **Engine:** `scrcpy` (độ trễ thấp, cap được FPS) hoặc `screenrecord` (không cần cài đặt).
- **Resolution (long side):** đòn bẩy giảm trễ mạnh nhất. Chọn `720`/`640`/`480 px` để mượt hơn nhiều; `Original` nét nhất nhưng chậm nhất.
- **Bitrate:** 1–16 Mbps. Mạng yếu thì giảm xuống 2–4 Mbps.
- **Max FPS:** 5–60 fps (mặc định 30) — **chỉ tác dụng với engine scrcpy**.
- **Preset nhanh:** Smooth / Balanced / Sharp / Original.

Đổi cài đặt khi đang stream sẽ tự kết nối lại. Nếu vẫn thấy trễ, hạ độ phân giải trước, rồi mới tới bitrate/FPS.

## Chỉ số độ trễ

Góc dưới bên phải màn hình hiển thị thời gian thực:

- **ms** — độ trễ vòng (RTT) đo qua WebSocket ping/pong: xanh `<80ms`, vàng `<200ms`, đỏ cao hơn. Đây là độ trễ mạng + server, phần đáng tin cậy nhất đo được.
- **fps** — số khung hình giải mã mỗi giây.
- **Mbps** — tốc độ dữ liệu video đang nhận.

Lưu ý: độ trễ "glass-to-glass" tuyệt đối (từ lúc màn hình đổi tới lúc hiện trên web) không đo chính xác được vì `screenrecord` không cấp timestamp khung hình; RTT là số sát thực nhất. Muốn đo chính xác con số này cần chuyển sang scrcpy/WebRTC có timestamp trên từng frame.

## Terminal ADB / Fastboot (nút "Terminal")

Nút **Terminal** mở một terminal web để chạy lệnh `adb` và `fastboot` trực tiếp:

- Gõ lệnh đầy đủ, ví dụ `adb devices`, `adb shell ls /sdcard`, `fastboot flash boot boot.img`. Output stream real-time.
- **Quick command**: các nút bấm sẵn (adb devices, fastboot devices, reboot bootloader/recovery…).
- **Target selected device (-s)**: tick để tự chèn `-s <serial>` vào lệnh `adb` (dùng thiết bị đang chọn).
- Gõ khi một lệnh đang chạy = gửi xuống **stdin** (trả lời prompt, hoặc `adb shell` tương tác). **Stop** để dừng. `↑/↓` để lật lịch sử lệnh.

**Bảo mật:** chỉ chấp nhận hai executable `adb` và `fastboot` (token đầu tiên của dòng lệnh phải đúng là chúng), và chạy **không qua shell** (tách tham số an toàn) nên không thể chèn lệnh kiểu `adb && del`. Đường dẫn fastboot đặt bằng `FASTBOOT_PATH` trong `.env` nếu không có trong PATH. Lưu ý: bản thân adb/fastboot rất mạnh (erase/flash…) — chỉ bật khi tin tưởng người truy cập.

## Xem Logcat (nút "Logcat")

Nút **Logcat** trên header bật/tắt panel logcat bên phải — xem song song khi vẫn đang điều khiển màn hình. Thiết kế để **xử lý lượng dòng rất lớn**:

- Stream live qua WebSocket, **giới hạn bộ đệm** ~5000 dòng gần nhất nên trình duyệt không bị nghẽn.
- **Lọc cấp độ** V / D / I / W / E (bấm bật/tắt, có lưu lựa chọn).
- **Lọc theo tag** và **theo text**, cùng ô **Highlight** để tô vàng từ khoá.
- Đếm `số dòng hiện / tổng`, **Auto-scroll** bật/tắt, **Clear** (xoá cả buffer trên thiết bị qua `logcat -c`).
- **Download** xuất các dòng đang hiển thị (đã lọc) ra file `logcat-<thời gian>.txt`.

Mẹo khi log quá nhiều: lọc cấp độ về `W`+`E` hoặc nhập tag/package cần quan tâm để giảm nhiễu, rồi Download phần đã lọc.

## Chạy script .bat (nút "Scripts")

Nút **Scripts** trên header mở popup kiểu terminal để chạy các file `.bat`:

- Danh sách gồm: file `.bat` trong thư mục `scripts/` **và** các file ghi trong **manifest** (`scripts/scripts.list`, đổi bằng `SCRIPTS_MANIFEST`).
- Manifest cho phép liệt kê `.bat` **ở bất kỳ đâu trên máy**. Mỗi dòng một file:

  ```
  # chú thích bắt đầu bằng # hoặc ;
  C:\full\path\to\file.bat
  Tên hiển thị = C:\tools\adb\reboot.bat
  Backup = %USERPROFILE%\Desktop\backup.bat     (hỗ trợ biến môi trường, ~)
  ```

- Chọn file → **Run**: log (stdout + stderr) stream trực tiếp về terminal.
- Ô nhập dưới cùng gửi text xuống **stdin** của tiến trình đang chạy (gõ rồi Enter) — trả lời được các prompt như `set /p`, `pause`, y/n…
- **Stop** kết thúc tiến trình; **Clear** xoá màn hình log. File trong manifest mà không tồn tại sẽ hiện mờ `(missing)`.

Mọi lệnh **stdin** bạn gửi đều được ghi vào file log `logs/stdin.log` (đổi bằng `STDIN_LOG` trong `.env`), mỗi dòng dạng `thời gian \t tên-script \t nội dung` — tiện rà lại sau.

### Nhiều người dùng cùng lúc

Khi nhiều máy cùng truy cập một server/thiết bị, tính năng phối hợp giúp tránh giẫm chân nhau:

- Đặt **"Your name"** trong mục Connection để người khác biết ai đang chạy gì.
- Mọi máy nhận **thông báo (toast)** khi có người bắt đầu một script, và khi một script **chạy xong** (kèm exit code).
- Nút **Scripts** có **badge** đếm số script đang chạy; trong popup, mỗi script đang chạy hiển thị nhãn **▶ tên-người**, và có dòng "Running" tổng hợp.
- Nếu bạn bấm Run một script **đang được chạy**, sẽ có hộp xác nhận "đang chạy bởi X — chạy tiếp?" để tránh chạy trùng.

Cơ chế: server giữ registry script đang chạy và quảng bá qua WebSocket `/events`; mọi máy khách mở kênh này (tự nối lại nếu rớt).

Có sẵn `scripts/example.bat` để thử (in `adb devices` và hỏi tên qua stdin).

Bảo mật: chỉ chạy được file có trong danh sách (thư mục `scripts/` hoặc manifest) — server đối chiếu **allowlist theo đường dẫn tuyệt đối**, nên không thể chạy file tuỳ ý ngoài danh sách. Vẫn cần token. Tính năng này chạy lệnh trên máy chủ — chỉ bật khi bạn tin tưởng người truy cập.

> Lưu ý: tính năng này dành cho Windows (chạy qua `cmd.exe`). Chạy server trên máy Windows có điện thoại cắm vào.

## Dùng qua Internet (an toàn)

> ⚠️ **Không** đặt `HOST=0.0.0.0` và mở cổng ra Internet trực tiếp, và **không** chạy `adb tcpip` phơi cổng 5555 ra ngoài — ai chạm tới đều có shell quyền cao. Hãy giữ server ở `127.0.0.1` và dùng một trong các tunnel sau:

**Cách 1 — Cloudflare Tunnel (dễ nhất, có HTTPS):**
```bash
cloudflared tunnel --url http://127.0.0.1:8000
```
Cloudflare trả về một URL `https://...trycloudflare.com`. Truy cập URL đó, nhập token. Vì là HTTPS nên trang dùng `wss://` tự động — và WebCodecs/clipboard hoạt động đầy đủ.

**Cách 2 — Tailscale (mạng riêng ảo, ổn định):**
Cài Tailscale trên máy chủ và máy khách, rồi truy cập `http://<tailscale-ip>:8000`. Đặt `HOST=0.0.0.0` *chỉ khi* đã có Tailscale làm lớp mạng riêng.

**Cách 3 — SSH reverse tunnel:**
```bash
ssh -R 8000:127.0.0.1:8000 user@server-co-public-ip
```
Sau đó truy cập qua server trung gian (nên đặt thêm HTTPS reverse proxy).

Dù dùng cách nào, **token vẫn là lớp xác thực bắt buộc**. Hãy đặt token dài, ngẫu nhiên.

## Giới hạn đã biết & hướng nâng cấp

- **Engine screenrecord:** trễ ~200–600ms, không cap FPS, tự khởi động lại mỗi ~170s (giật ngắn). Dùng engine **scrcpy** để khắc phục.
- **Engine scrcpy:** trễ thấp hơn nhiều và cap được FPS. Lưu ý `SCRCPY_VERSION` phải khớp file đã tải. Hiện chỉ dùng scrcpy cho **video**; input vẫn qua `adb shell input`.
- **Input dạng tap/swipe** (chưa kéo-thả mượt real-time) vì `adb input` tạo tiến trình mỗi lần. Muốn vuốt mượt → bật socket control của scrcpy và gửi control message nhị phân (touch down/move/up).
- **Độ trễ thấp nhất qua Internet** → chuyển sang **WebRTC** (H.264 + RTCDataChannel cho input, cần STUN/TURN).
- **Nhiều thiết bị / device farm** → mở rộng theo kiến trúc OpenSTF/DeviceFarmer.

## Cấu trúc

```
adb-web-control/
├── server.py            # FastAPI + WebSocket: video, input, scripts, logcat, token auth
├── adb.py               # bao quanh adb: devices, screen size, screenrecord, scrcpy, logcat, input, wake
├── runner.py            # chạy .bat, stream log, nhận stdin, ghi log stdin
├── static/
│   ├── index.html       # chỉ markup (UI), nạp JS dạng ES module
│   └── js/              # frontend tách module cho dễ bảo trì
│       ├── core.js      #   tiện ích: $, localStorage, wsProto
│       ├── decoder.js   #   lớp H264Decoder (WebCodecs + tách NAL)
│       ├── devices.js   #   quét & đổ danh sách thiết bị
│       ├── settings.js  #   nạp/lưu cài đặt, ô chất lượng, sidebar
│       ├── video.js     #   kết nối video + thống kê + TỰ KẾT NỐI LẠI
│       ├── input.js     #   chuột/cảm ứng/bàn phím -> input
│       ├── scripts.js   #   popup chạy .bat
│       ├── logcat.js    #   panel logcat (lọc, highlight, resize, xuất file)
│       └── main.js      #   điểm vào: lắp ráp các module
├── scripts/             # nơi đặt file .bat (example.bat) + manifest scripts.list
├── logs/                # logs/stdin.log (tạo khi cần)
├── vendor/              # scrcpy-server tự tải về (tạo khi cần)
├── requirements.txt
├── .env.example
└── README.md
```

Frontend chia theo module ES (`import`/`export`), mỗi tính năng một file để dễ sửa độc lập. Đồ thị phụ thuộc một chiều: `main` lắp ráp tất cả; `video` dùng `decoder`/`devices`/`settings`/`core`; `input` dùng `video`; các module khác chỉ dùng `core`.
