/**
 * Real video compression for the call's Color mode, using the browser's WebCodecs encoder/decoder (hardware-accelerated
 * on most phones). Inter-frame prediction is worth enormously more than anything a still-image scheme can do: on a
 * moving test clip H.264 reached the picture quality the quadtree codec needed ~30× the bytes for. That matters most
 * when the call is relayed through a bandwidth-capped (free-tier) TURN server.
 *
 * Both ends must support it, so the peers first exchange which codecs they can decode; the sender only uses a codec
 * both sides have, and falls back to the quadtree codec (adaptive.ts) otherwise — or whenever anything goes wrong.
 *
 * Packet:  [0xC0 | codec<<1 | key] ( [w:u16] [h:u16] if key ) [timestamp:u32 ms] [encoded chunk]
 * (0xC0 can't collide: legacy ASCII/colour frames never set bit 7, quadtree packets set bit 7 but never bit 6.)
 */

export const VIDEO_PACKET_MASK = 0xc0;

export type VideoCodecId = 0 | 1 | 2;
/** Codec ids in the order the sender prefers them (H.264 is hardware-encoded almost everywhere). */
export const VIDEO_CODEC_PREFERENCE: VideoCodecId[] = [0, 2, 1];

const CODEC_STRING: Record<VideoCodecId, string> = {
  0: "avc1.42001f",       // H.264 constrained baseline, level 3.1
  1: "vp8",
  2: "vp09.00.10.08",     // VP9 profile 0, 8-bit
};

/** Human-readable names for diagnostics (e.g. CallTab's periodic perfStats log) — not used by the codec itself. */
export const VIDEO_CODEC_NAME: Record<VideoCodecId, string> = { 0: "h264", 1: "vp8", 2: "vp9" };

export const webCodecsAvailable = (): boolean =>
  typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined";

function encoderConfig(id: VideoCodecId, w: number, h: number, bitrate: number, fps: number): VideoEncoderConfig {
  const cfg: VideoEncoderConfig = {
    codec: CODEC_STRING[id], width: w, height: h, bitrate, framerate: fps,
    latencyMode: "realtime", bitrateMode: "variable",
  };
  if (id === 0) (cfg as VideoEncoderConfig & { avc?: { format: string } }).avc = { format: "annexb" }; // parameter sets travel in-band with every keyframe
  return cfg;
}

/** Which of our codecs this browser can ENCODE at roughly the sizes we use. */
export async function probeEncoders(): Promise<VideoCodecId[]> {
  if (!webCodecsAvailable()) return [];
  const out: VideoCodecId[] = [];
  for (const id of VIDEO_CODEC_PREFERENCE) {
    try {
      const r = await VideoEncoder.isConfigSupported(encoderConfig(id, 320, 240, 200_000, 20));
      if (r.supported) out.push(id);
    } catch { /* not supported */ }
  }
  return out;
}

/** Which of our codecs this browser can DECODE. */
export async function probeDecoders(): Promise<VideoCodecId[]> {
  if (!webCodecsAvailable()) return [];
  const out: VideoCodecId[] = [];
  for (const id of VIDEO_CODEC_PREFERENCE) {
    try {
      const r = await VideoDecoder.isConfigSupported({ codec: CODEC_STRING[id], optimizeForLatency: true });
      if (r.supported) out.push(id);
    } catch { /* not supported */ }
  }
  return out;
}

/** Capture size and bitrate for a quality tier: long side in px (multiple of 16), bits per second.
 *  "extreme" (call.ts's CallQualityLevel) is a non-video-codec tier added for the ascii/color-ascii/pixel/color
 *  character-grid modes only -- real video is slated to move to a separate app later and isn't the target of that
 *  work, so this entry just mirrors "max" to keep VIDEO_TIERS[level] a valid lookup for every CallQualityLevel
 *  without changing video behavior at all. */
export const VIDEO_TIERS = {
  low:     { long: 192, bitrate:  70_000 },
  medium:  { long: 256, bitrate: 140_000 },
  high:    { long: 320, bitrate: 260_000 },
  ultra:   { long: 384, bitrate: 420_000 },
  max:     { long: 448, bitrate: 650_000 },
  extreme: { long: 448, bitrate: 650_000 },
} as const;

/** Both sides multiples of 16 (hardware encoders pad anything else), aspect kept. */
export function videoDims(vw: number, vh: number, long: number): { w: number; h: number } {
  const landscape = vw >= vh;
  const short = Math.max(16, Math.round(long * (landscape ? vh / vw : vw / vh) / 16) * 16);
  return landscape ? { w: long, h: short } : { w: short, h: long };
}

export class VideoSender {
  private enc: VideoEncoder | null = null;
  private cfgKey = "";
  private codec: VideoCodecId = 0;
  private w = 0;
  private h = 0;
  private seq = 0;
  private failed = false;
  private needKey = true;

  /** Called with every finished packet, in order. */
  onPacket: (packet: ArrayBuffer, key: boolean) => void = () => {};
  /** The encoder died or became unusable — the caller should fall back to another codec. */
  onFailure: () => void = () => {};

  get usable() { return !this.failed; }

  /** Ask for a keyframe on the next frame (new viewer, lost packet, mode switch…). */
  requestKey() { this.needKey = true; }

  reset() { this.close(); this.failed = false; this.needKey = true; }

  close() {
    try { this.enc?.close(); } catch { /* already closed */ }
    this.enc = null; this.cfgKey = "";
  }

  private ensure(codec: VideoCodecId, w: number, h: number, bitrate: number, fps: number): boolean {
    const key = `${codec}|${w}|${h}|${bitrate}|${fps}`;
    if (this.enc && this.enc.state !== "closed" && key === this.cfgKey) return true;
    try {
      const sameShape = this.enc && this.enc.state !== "closed" && this.codec === codec && this.w === w && this.h === h;
      if (!sameShape) {
        this.close();
        this.enc = new VideoEncoder({
          output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const isKey = chunk.type === "key";
            const head = isKey ? 9 : 5;
            const pkt = new Uint8Array(head + data.length);
            pkt[0] = VIDEO_PACKET_MASK | (this.codec << 1) | (isKey ? 1 : 0);
            let p = 1;
            if (isKey) { pkt[1] = this.w >> 8; pkt[2] = this.w & 255; pkt[3] = this.h >> 8; pkt[4] = this.h & 255; p = 5; }
            const ts = Math.round(chunk.timestamp / 1000) >>> 0;
            pkt[p] = ts >>> 24; pkt[p + 1] = (ts >>> 16) & 255; pkt[p + 2] = (ts >>> 8) & 255; pkt[p + 3] = ts & 255;
            pkt.set(data, p + 4);
            this.onPacket(pkt.buffer, isKey);
          },
          error: () => { this.failed = true; this.close(); this.onFailure(); },
        });
        this.codec = codec; this.w = w; this.h = h;
      }
      this.enc!.configure(encoderConfig(codec, w, h, bitrate, fps));
      this.cfgKey = key;
      this.needKey = true; // any reconfiguration starts a fresh group of pictures
      return true;
    } catch {
      this.failed = true; this.close(); this.onFailure();
      return false;
    }
  }

  /**
   * Encodes one RGBA frame. Returns false if it was skipped (encoder backed up or unusable) — skipping an INPUT frame is
   * harmless for inter prediction, the encoder just sees a longer gap.
   */
  encode(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, codec: VideoCodecId, bitrate: number, fps: number, forceKey: boolean): boolean {
    if (this.failed) return false;
    if (!this.ensure(codec, w, h, bitrate, fps)) return false;
    const enc = this.enc!;
    if (enc.encodeQueueSize > 3) return false;
    try {
      const ts = Math.round(this.seq++ * 1e6 / fps);
      const frame = new VideoFrame(rgba as BufferSource, { format: "RGBA", codedWidth: w, codedHeight: h, timestamp: ts });
      const key = forceKey || this.needKey;
      enc.encode(frame, { keyFrame: key });
      frame.close();
      if (key) this.needKey = false;
      return true;
    } catch {
      this.failed = true; this.close(); this.onFailure();
      return false;
    }
  }
}

export class VideoReceiver {
  /**
   * The decoded picture; redrawn into on every output frame. Never attached to the DOM. The caller (CallTab.tsx's
   * paintCanvas, via RemoteFrame.canvas) reads pixels directly off THIS canvas, lazily, once per rAF-coalesced paint —
   * not here, and not once per decoded frame. See call.ts's videoRx.onFrame for why that distinction matters (an
   * earlier version of this fix got it backwards and measured worse than the original double-draw it replaced).
   * willReadFrequently is still requested up front so whichever context ends up reading this canvas gets it (a second
   * getContext() call on the same canvas returns this same context, options and all).
   */
  readonly canvas: HTMLCanvasElement = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  private dec: VideoDecoder | null = null;
  private cfgKey = "";
  private haveKey = false;
  private chain: Promise<void> = Promise.resolve();

  /** A new picture is in `canvas`. */
  onFrame: () => void = () => {};
  /** We can't continue without a keyframe (gap, decode error…). */
  onNeedKey: () => void = () => {};
  /** This browser can't decode what was sent. */
  onUnsupported: () => void = () => {};

  reset() { this.close(); this.chain = Promise.resolve(); }

  close() {
    try { this.dec?.close(); } catch { /* already closed */ }
    this.dec = null; this.cfgKey = ""; this.haveKey = false;
  }

  /** Packets are handled strictly in order (configuring a decoder is async). */
  push(pkt: Uint8Array) {
    this.chain = this.chain.then(() => this.handle(pkt)).catch(() => { this.close(); this.onNeedKey(); });
  }

  private async handle(d: Uint8Array) {
    if (d.length < 6 || (d[0] & VIDEO_PACKET_MASK) !== VIDEO_PACKET_MASK) return;
    const key = (d[0] & 1) === 1;
    const codec = ((d[0] >> 1) & 3) as VideoCodecId;
    if (!(codec in CODEC_STRING)) { this.onUnsupported(); return; }
    let p = 1;
    if (key) {
      if (d.length < 10) return;
      const w = (d[1] << 8) | d[2], h = (d[3] << 8) | d[4];
      p = 5;
      const cfgKey = `${codec}|${w}|${h}`;
      if (!this.dec || this.dec.state === "closed" || cfgKey !== this.cfgKey) {
        this.close();
        const cfg: VideoDecoderConfig = { codec: CODEC_STRING[codec], codedWidth: w, codedHeight: h, optimizeForLatency: true };
        const sup = await VideoDecoder.isConfigSupported(cfg);
        if (!sup.supported) { this.onUnsupported(); return; }
        this.dec = new VideoDecoder({
          output: (frame) => {
            if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth;
            if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight;
            this.ctx?.drawImage(frame, 0, 0);
            frame.close();
            this.onFrame();
          },
          error: () => { this.close(); this.onNeedKey(); },
        });
        this.dec.configure(cfg);
        this.cfgKey = cfgKey;
      }
      this.haveKey = true;
    } else if (!this.haveKey || !this.dec || this.dec.state === "closed") {
      this.onNeedKey();
      return;
    }
    const ts = ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
    this.dec!.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts * 1000, data: d.subarray(p + 4) }));
  }
}
