// decoder.js — Giải mã H.264 (WebCodecs), ghép NAL Annex-B thành access unit.
//
// Dùng: const dec = new H264Decoder(canvas, onFrame);
//        dec.feed(arrayBuffer);   // nạp byte H.264 thô
//        dec.reset();             // xoá trạng thái khi (re)connect
// onFrame() được gọi sau mỗi khung vẽ lên canvas (để đếm fps / ẩn overlay).

export class H264Decoder {
  constructor(canvas, onFrame) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onFrame = onFrame || (() => {});
    this.reset();
    this._setup();
  }

  reset() {
    this.configured = false;
    this.firstKeySent = false;
    this.codecString = null;
    this.frameIndex = 0;
    this.pending = new Uint8Array(0);
    this.curAU = [];
    this.curHasVCL = false;
    this.curKey = false;
  }

  _setup() {
    this.dec = new VideoDecoder({
      output: (frame) => {
        const c = this.canvas;
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
          c.width = frame.displayWidth;
          c.height = frame.displayHeight;
        }
        this.ctx.drawImage(frame, 0, 0);
        frame.close();
        this.onFrame();
      },
      error: (e) => {
        console.error("Decoder error:", e);
        try { this.dec.close(); } catch (_) {}
        this.reset();
        this._setup();
      },
    });
  }

  _concat(a, b) {
    const o = new Uint8Array(a.length + b.length);
    o.set(a, 0); o.set(b, a.length);
    return o;
  }

  _findStartCodes(buf) {
    const idx = []; let i = 0; const n = buf.length - 2;
    while (i < n) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { idx.push(i); i += 3; }
      else i++;
    }
    return idx;
  }

  _configureFromSPS(nal) {
    const h2 = (v) => v.toString(16).padStart(2, "0");
    let cs = "avc1.42e01e";
    if (nal.length >= 4) cs = "avc1." + h2(nal[1]) + h2(nal[2]) + h2(nal[3]);
    if (cs !== this.codecString || !this.configured) {
      this.codecString = cs;
      try {
        this.dec.configure({ codec: this.codecString, optimizeForLatency: true });
        this.configured = true;
      } catch (e) {
        console.error("configure() error:", e, this.codecString);
        this.configured = false;
      }
    }
  }

  _flushAU() {
    if (this.curAU.length === 0) return;
    let total = 0;
    for (const nal of this.curAU) total += 4 + nal.length;
    const buf = new Uint8Array(total); let off = 0;
    for (const nal of this.curAU) {
      buf[off] = 0; buf[off + 1] = 0; buf[off + 2] = 0; buf[off + 3] = 1;
      buf.set(nal, off + 4); off += 4 + nal.length;
    }
    this.curAU = [];
    const wasKey = this.curKey;
    this.curKey = false; this.curHasVCL = false;
    if (!this.configured) return;
    if (!this.firstKeySent && !wasKey) return;
    if (wasKey) this.firstKeySent = true;
    try {
      this.dec.decode(new EncodedVideoChunk({
        type: wasKey ? "key" : "delta",
        timestamp: (this.frameIndex++) * 16667,
        data: buf,
      }));
    } catch (e) {
      console.error("decode() error:", e);
    }
  }

  _handleNAL(nal) {
    if (nal.length === 0) return;
    const type = nal[0] & 0x1f;
    const isVCL = type >= 1 && type <= 5;
    if (type === 7) this._configureFromSPS(nal);
    if (isVCL && this.curHasVCL) this._flushAU();
    this.curAU.push(nal);
    if (isVCL) this.curHasVCL = true;
    if (type === 5 || type === 7) this.curKey = true;
  }

  feed(arrayBuf) {
    this.pending = this._concat(this.pending, new Uint8Array(arrayBuf));
    const codes = this._findStartCodes(this.pending);
    if (codes.length < 2) return;
    for (let k = 0; k < codes.length - 1; k++) {
      this._handleNAL(this.pending.subarray(codes[k] + 3, codes[k + 1]));
    }
    this.pending = this.pending.slice(codes[codes.length - 1]);
  }
}
