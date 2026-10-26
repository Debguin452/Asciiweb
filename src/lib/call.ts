import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import {
  encodeFrame, decode, toArrayBuffer, ColorQuantizer, type RemoteFrame,
} from "./binary";
import { AdaptiveEncoder, AdaptiveDecoder, ADAPTIVE_FLAG } from "./adaptive";
import {
  VideoSender, VideoReceiver, VIDEO_PACKET_MASK, VIDEO_CODEC_PREFERENCE, VIDEO_TIERS,
  probeEncoders, probeDecoders, videoDims, webCodecsAvailable, type VideoCodecId,
} from "./videocodec";
// Measurement only (see perfStats.ts) — used to decide WHETHER the quadtree quantize/encode path is actually worth
// moving to WASM, instead of guessing. Same ring-buffer instrumentation already used on the receive side.
import { record as recordPerf, sizedBucket } from "./perfStats";

// Fallback ICE servers, used whenever /api/turn isn't configured (it isn't —
// that was the Cloudflare-billed path, skipped in favor of this) or its
// fetch fails for any other reason. The browser tries every TURN entry
// given to it and uses whichever actually gets through, so listing more
// than one TURN provider is pure upside, not a tradeoff — it's kept
// deliberately redundant across BOTH provider and port/transport:
//   - ExpressTURN (free, account-scoped static credentials — their own
//     docs confirm that's fine for this tier, see
//     https://www.expressturn.com/docs/peerjs) on port 3478, UDP + TCP.
//   - The openrelay.metered.ca demo credential on ports 80 and 443,
//     UDP + TCP. It's a widely shared, unauthenticated free demo pair
//     (openrelayproject/openrelayproject) copied into countless WebRTC
//     tutorials, so it's not trusted alone — but it's free, and critically
//     it covers port 443, which ExpressTURN's free tier doesn't confirm.
// Some mobile carriers and corporate firewalls block non-standard UDP
// ports outright (3478 included) while leaving 443 open, since that's
// also plain HTTPS traffic — so having a 443 option matters independently
// of which provider's relay actually ends up being used. The plain
// stun:* entries stay as extra, free, unauthenticated candidate sources
// regardless of all of the above.
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:free.expressturn.com:3478" },
  {
    urls: [
      "turn:free.expressturn.com:3478?transport=udp",
      "turn:free.expressturn.com:3478?transport=tcp",
    ],
    username: "000000002107743162",
    credential: "PDWdMB8cuWFugJUzH8rdv6hCUnY=",
  },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

// Cached across calls in the same page session — no need to re-fetch fresh
// short-lived credentials (1hr TTL, see turn.ts) for every single call.
let cachedIceServers: RTCIceServer[] | null = null;
let cachedIceServersAt = 0;
const ICE_SERVERS_CACHE_MS = 30 * 60 * 1000; // refetch well before the 1hr TTL expires

async function fetchIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (cachedIceServers && now - cachedIceServersAt < ICE_SERVERS_CACHE_MS) {
    return cachedIceServers;
  }
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch("/api/turn", { signal: ctrl.signal });
    clearTimeout(timeout);
    if (r.ok) {
      const data = await r.json() as { iceServers?: RTCIceServer[] };
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        cachedIceServers = data.iceServers;
        cachedIceServersAt = now;
        return cachedIceServers;
      }
    }
  } catch { /* /api/turn not set up yet, or offline — fall back below */ }
  return FALLBACK_ICE_SERVERS;
}

/** The call's media leg only needs audio — the picture travels as ASCII over the data channel. Sending the camera track as well wasted
 *  upload bandwidth and a full video-encoder's worth of CPU competing with the frame stream. */
function audioOnly(stream: MediaStream): MediaStream {
  const a = stream.getAudioTracks();
  return a.length ? new MediaStream(a) : stream;
}

const RECONNECT_DELAY = 1500;
const MAX_RECONNECT_ATTEMPTS = 5;

/** Group-call cap: this many *other* participants, plus yourself, so a call tops out at 4 people total. Mesh (everyone connects
 *  to everyone, no media server) is fine at this size on a phone CPU/battery; much beyond it the per-peer encode cost (every
 *  frame is quantized/encoded once per remote participant — see CallManager.broadcast below) stops being worth it. */
export const MAX_REMOTE_PEERS = 3;

export type CallQualityLevel = "low" | "medium" | "high" | "ultra" | "max" | "extreme";

export interface CallQualityStep {
  keyframeInterval: number;
  targetFps: number;
  maxFrameSize: number; // bytes; a single frame over this is skipped rather than sent
  resScale: number; // multiplier applied to the capture grid (cols/rows) at this level
}

// resScale lets congestion shrink the actual captured grid, not just the frame
// rate / drop threshold. Previously only fps and the drop-above-this-size
// threshold responded to network conditions — the capture resolution itself
// was fixed, so a congested link either sent big, slow frames or silently
// dropped them outright (while an always-full-size keyframe still went out
// every keyframeInterval regardless, since dispatch() never size-gates
// keyframes). Scaling resolution down with quality keeps keyframes cheap too.
// Frame rates are capped at what cameras actually deliver (≤30) — computing and sending 48-60 "frames"
// per second only re-processed duplicate camera frames. The budget goes into grid resolution instead.
// "extreme" only matters for the character/block-grid modes (ascii, color-ascii, pixel, color) -- real video (WebCodecs)
// uses its own separate VIDEO_TIERS ladder entirely and is unaffected. resScale is deliberately kept at 1.0, same as
// "max": the capture grid for ascii/color-ascii is already sized to the smallest LEGIBLE font (ASCII_MAX_CELLS/
// COLOR_MAX_CELLS in CallTab.tsx, tuned to a 5px floor), so a bigger grid wouldn't add perceptible detail there, only
// illegible glyphs -- the actual headroom a good connection can spend is fewer forced frame drops on busy/complex
// scenes (maxFrameSize raised 50% over "max") and a crisper periodic refresh (shorter keyframeInterval). targetFps
// stays at 30: cameras in this app don't deliver faster than that anyway (see the comment above), so there's nothing
// to gain by raising it further. Reachable ONLY through the existing proven upgrade hysteresis (adaptQuality() below,
// unchanged) -- 3 consecutive "healthy" checks -- so it never engages unless the connection is already genuinely good.
const QUALITY_STEPS: Record<CallQualityLevel, CallQualityStep> = {
  low:     { keyframeInterval: 60, targetFps: 10, maxFrameSize: 6000,  resScale: 0.5  },
  medium:  { keyframeInterval: 60, targetFps: 15, maxFrameSize: 12000, resScale: 0.7  },
  high:    { keyframeInterval: 60, targetFps: 20, maxFrameSize: 24000, resScale: 0.85 },
  ultra:   { keyframeInterval: 60, targetFps: 24, maxFrameSize: 40000, resScale: 1.0  },
  max:     { keyframeInterval: 60, targetFps: 30, maxFrameSize: 60000, resScale: 1.0  },
  extreme: { keyframeInterval: 45, targetFps: 30, maxFrameSize: 90000, resScale: 1.0  },
};

const QUALITY_ORDER: CallQualityLevel[] = ["low", "medium", "high", "ultra", "max", "extreme"];

const BUFFERED_AMOUNT_LOW_THRESHOLD = 96 * 1024;
const BUFFERED_AMOUNT_CRITICAL = 1024 * 1024;

export type CallStatus = "idle" | "waiting" | "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface RemoteState {
  micMuted: boolean;
  camOff: boolean;
}

/** Every callback now carries which remote participant it's about — the one thing that's new versus the old single-peer shape. */
export interface CallManagerEvents {
  onStatus: (peerId: string, status: CallStatus, detail?: string) => void;
  onRemoteFrame: (peerId: string, frame: RemoteFrame) => void;
  onRemoteHangup: (peerId: string) => void;
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onRemoteState?: (peerId: string, state: RemoteState) => void;
  onQualityChange?: (peerId: string, level: CallQualityLevel, step: CallQualityStep) => void;
  onIdChanged?: (newId: string, oldId: string) => void;
  /** A 4th participant tried to join while the call was already full — nobody was connected to. */
  onRoomFull?: (peerId: string) => void;
}

interface SessionEvents {
  onStatus: (status: CallStatus, detail?: string) => void;
  onRemoteFrame: (frame: RemoteFrame) => void;
  onRemoteHangup: () => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteState: (state: RemoteState) => void;
  onQualityChange: (level: CallQualityLevel, step: CallQualityStep) => void;
  /** Our own outgoing leg to this peer died and the peer is still around — ask CallManager to redial it (see rejoin() below). */
  onNeedRedial: () => void;
}

/**
 * Everything the old single-peer `CallManager` tracked per-connection — codec state, quality ramping, RTT, heartbeat,
 * reconnect — now scoped to exactly one remote participant, so a group call is just several of these running side by side.
 * Each session encodes and quantizes independently: with no media server, there is no way to send one encoded frame to
 * three different peers, so the CPU cost of Color/Pixel mode scales with participant count. That's the real ceiling
 * MAX_REMOTE_PEERS is protecting.
 */
class PeerSession {
  readonly peerId: string;
  private isHost: boolean;
  private events: SessionEvents;

  private dataConn: DataConnection | null = null;
  private mediaConn: MediaConnection | null = null;
  private pendingIncomingCall: MediaConnection | null = null;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private prevSentIndices: Uint8Array | null = null;
  private prevSentColorIdx: Uint8Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private quant = new ColorQuantizer();
  private adaptEnc = new AdaptiveEncoder();
  private adaptDec = new AdaptiveDecoder();
  // ── WebCodecs video (Color mode). Used only when BOTH peers can handle a common codec; otherwise the quadtree codec runs.
  private videoTx = new VideoSender();
  private videoRx = new VideoReceiver();
  private remoteDec: VideoCodecId[] | null = null;   // what the peer told us it can decode (null = not yet)
  private videoDisabled = false;                     // an error or the peer's "nowc" switched us back to the quadtree codec
  private curChars = new Uint8Array(0); // reused per-frame scratch (no per-frame allocations on the hot path)
  private lastKind = 0;                  // 1 = ascii, 2 = colored ascii, 3 = color blocks, 4 = legacy pixel, 5 = adaptive color, 6 = adaptive pixel art, 7 = real video; a change forces a keyframe (+palette)
  private framesSinceKey = 0;
  private needKeyframe = true;
  private lastKfRequestAt = 0;
  private rtt = 0;
  private rttBase = 0;
  private rttSamples: number[] = [];
  private consecutiveDrops = 0;
  private frameCount = 0;
  private keyframeInterval = QUALITY_STEPS.medium.keyframeInterval;
  private lastSentAt = 0;
  private targetFps = QUALITY_STEPS.medium.targetFps;
  private maxFrameSize = QUALITY_STEPS.medium.maxFrameSize;

  private receivedKeyframe = false;

  private qualityLevel: CallQualityLevel = "medium";
  private recentSends = 0;
  private recentDrops = 0;
  private qualityCheckCounter = 0;
  private consecutiveGood = 0;
  private consecutiveBad = 0;
  private readonly CHECK_FRAMES = 15;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecvAt = 0;
  private readonly HEARTBEAT_INTERVAL = 1000;
  private readonly STALE_TIMEOUT = 9000;

  private fpsCap = 60;

  // Shared across sessions (probed once by CallManager) — what THIS browser can encode.
  private encCodecs: VideoCodecId[];

  constructor(peerId: string, isHost: boolean, encCodecs: VideoCodecId[], events: SessionEvents) {
    this.peerId = peerId;
    this.isHost = isHost;
    this.encCodecs = encCodecs;
    this.events = events;
    this.videoTx.onPacket = (buf, key) => this.dispatchVideo(buf, key);
    this.videoTx.onFailure = () => { this.videoDisabled = true; this.needKeyframe = true; };
    this.videoRx.onFrame = () => {
      // Deliberately NOT reading pixels here: this fires once per DECODED frame, before CallTab's rAF coalescing gets
      // a chance to drop stale ones (it only ever paints the latest pending frame, once per display tick). An earlier
      // version of this fix called the readback here, eagerly — turning "N decodes → 1 readback" into "N decodes → N
      // readbacks" whenever frames arrived faster than they could be painted, which on-device measurement showed was
      // far WORSE than the original double-draw it was meant to replace (median 51-71ms, max 1384ms vs. the original's
      // 10-30ms median). The canvas reference itself is cheap to hand over; CallTab reads it lazily, once per paint.
      const c = this.videoRx.canvas;
      this.prevRecvFrame = null;
      this.events.onRemoteFrame({
        w: c.width, h: c.height, charset: "", charIndices: new Uint8Array(0), palette: null, colorIndices: null,
        isKeyframe: false, isBlockColor: false, isPixelated: false, canvas: c, timestamp: performance.now(),
      });
    };
    this.videoRx.onNeedKey = () => this.requestKeyframe();
    this.videoRx.onUnsupported = () => { try { this.dataConn?.send({ type: "nowc" }); } catch { /* noop */ } };
  }

  connect(peer: Peer, stream: MediaStream | null) {
    this.isHost = false;
    this.events.onStatus("connecting", this.peerId);
    const conn = peer.connect(this.peerId, { reliable: true, serialization: "binary" });
    this.attachData(conn);
    if (stream) {
      const call = peer.call(this.peerId, audioOnly(stream));
      this.mediaConn = call;
      this.attachMedia(call);
    }
  }

  /** The host side answers an incoming media call once a local stream exists (it may not yet, if the camera is still starting). */
  attachIncomingCall(call: MediaConnection, stream: MediaStream | null) {
    this.mediaConn = call;
    this.attachMedia(call);
    if (stream) call.answer(audioOnly(stream));
    else this.pendingIncomingCall = call;
  }

  answerWithStream(stream: MediaStream) {
    if (this.pendingIncomingCall) {
      const call = this.pendingIncomingCall;
      this.pendingIncomingCall = null;
      call.answer(audioOnly(stream));
    } else if (this.mediaConn && this.mediaConn.open === false) {
      this.mediaConn.answer(audioOnly(stream));
    }
  }

  private onRtt(ms: number) {
    this.rtt = this.rtt ? this.rtt * 0.7 + ms * 0.3 : ms;
    this.rttSamples.push(ms);
    if (this.rttSamples.length > 30) this.rttSamples.shift();
    this.rttBase = Math.min(...this.rttSamples);
  }

  private requestKeyframe() {
    const now = performance.now();
    if (now - this.lastKfRequestAt < 400 || !this.dataConn?.open) return;
    this.lastKfRequestAt = now;
    try { this.dataConn.send({ type: "kf" }); } catch { /* noop */ }
  }

  private adaptQuality() {
    const dropRate = this.recentSends > 0 ? this.recentDrops / this.recentSends : 0;
    const buffered = this.dataConn?.dataChannel?.bufferedAmount ?? 0;
    const idx = QUALITY_ORDER.indexOf(this.qualityLevel);
    if (idx === -1) return;

    const rttKnown = this.rtt > 0;
    const congested = buffered > BUFFERED_AMOUNT_LOW_THRESHOLD || dropRate > 0.2 || (rttKnown && this.rtt > this.rttBase * 2.5 + 120);
    const healthy   = buffered < 16 * 1024 && dropRate < 0.05 && (!rttKnown || this.rtt < this.rttBase * 1.7 + 60);

    if (congested && idx > 0) {
      this.consecutiveBad++;
      this.consecutiveGood = 0;
      const severe = buffered > BUFFERED_AMOUNT_CRITICAL;
      if (this.consecutiveBad >= (severe ? 1 : 2)) {
        this.setQuality(QUALITY_ORDER[Math.max(0, idx - (severe ? 2 : 1))]);
        this.consecutiveBad = 0;
      }
    } else if (healthy && idx < QUALITY_ORDER.length - 1) {
      this.consecutiveGood++;
      this.consecutiveBad = 0;
      if (this.consecutiveGood >= 3) {
        this.consecutiveGood = 0;
        this.setQuality(QUALITY_ORDER[idx + 1]);
      }
    } else {
      this.consecutiveBad = 0;
      if (!healthy) this.consecutiveGood = 0;
    }
  }

  private setQuality(level: CallQualityLevel) {
    this.qualityLevel = level;
    const step = QUALITY_STEPS[level];
    this.keyframeInterval = step.keyframeInterval;
    this.targetFps        = step.targetFps;
    this.maxFrameSize      = step.maxFrameSize;
    this.events.onQualityChange(level, step);
  }

  private attachMedia(call: MediaConnection) {
    const current = () => !this.destroyed && this.mediaConn === call;
    call.on("stream", s => { if (current()) this.events.onRemoteStream(s); });
    call.on("close", () => { if (current()) this.events.onRemoteHangup(); });
    call.on("error", () => { if (current()) this.mediaConn = null; });
    call.on("iceStateChanged", state => {
      if (state === "failed") {
        try { call.close(); } catch { /* noop */ }
      }
    });
  }

  attachData(conn: DataConnection) {
    this.dataConn = conn;

    conn.on("open", () => {
      if (this.dataConn !== conn) return;
      this.reconnectAttempts = 0;
      this.events.onStatus("connected");
      this.receivedKeyframe = false;
      this.prevRecvFrame    = null;
      this.adaptDec.reset();
      this.videoRx.reset(); this.videoTx.reset();
      this.remoteDec = null; this.videoDisabled = false;
      probeDecoders().then(dec => { try { conn.send({ type: "caps", dec }); } catch { /* noop */ } }).catch(() => {});
      this.lastRecvAt = performance.now();
      this.startHeartbeat();
    });

    conn.on("data", (data: unknown) => {
      if (this.dataConn !== conn) return;
      this.lastRecvAt = performance.now();

      if (data && typeof data === "object" && "type" in (data as Record<string, unknown>) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
        const m = data as { type: string; t?: number; micMuted?: boolean; camOff?: boolean; dec?: number[] };
        if (m.type === "ping") { try { conn.send({ type: "pong", t: m.t }); } catch { /* noop */ } return; }
        if (m.type === "pong") { if (typeof m.t === "number") this.onRtt(performance.now() - m.t); return; }
        if (m.type === "kf") { this.needKeyframe = true; return; }
        if (m.type === "caps") { this.remoteDec = Array.isArray(m.dec) ? (m.dec.filter(n => n === 0 || n === 1 || n === 2) as VideoCodecId[]) : []; return; }
        if (m.type === "nowc") { this.videoDisabled = true; this.needKeyframe = true; return; }
        if (m.type === "state") { this.events.onRemoteState({ micMuted: !!m.micMuted, camOff: !!m.camOff }); return; }
        return;
      }

      const buf = toArrayBuffer(data);
      const b0 = buf && buf.byteLength > 0 ? new Uint8Array(buf, 0, 1)[0] : 0;
      if (buf && (b0 & VIDEO_PACKET_MASK) === VIDEO_PACKET_MASK) {
        this.videoRx.push(new Uint8Array(buf));
      } else if (buf && (b0 & ADAPTIVE_FLAG)) {
        const image = this.adaptDec.decode(new Uint8Array(buf));
        if (image) {
          this.prevRecvFrame = null;
          this.events.onRemoteFrame({
            w: image.width, h: image.height, charset: "", charIndices: new Uint8Array(0), palette: null, colorIndices: null,
            isKeyframe: false, isBlockColor: false, isPixelated: this.adaptDec.lastPixelated, image, timestamp: performance.now(),
          });
        } else this.requestKeyframe();
      } else if (buf) {
        const frame = decode(buf, this.prevRecvFrame);
        if (frame) {
          if (frame.isKeyframe) this.receivedKeyframe = true;
          if (frame.isKeyframe || this.receivedKeyframe) {
            this.prevRecvFrame = frame;
            this.events.onRemoteFrame(frame);
          }
        } else {
          this.requestKeyframe();
        }
      }
    });

    conn.on("iceStateChanged", state => {
      if (this.destroyed || this.dataConn !== conn) return;
      if (state === "disconnected") {
        this.events.onStatus("reconnecting");
      } else if (state === "failed") {
        this.tryRedial();
      } else if (state === "connected" || state === "completed") {
        this.reconnectAttempts = 0;
        if (this.dataConn?.open) this.events.onStatus("connected");
      }
    });

    conn.on("close", () => {
      if (this.dataConn !== conn) return;
      this.stopHeartbeat();
      if (!this.destroyed) this.events.onStatus("closed");
    });
    conn.on("error", err => {
      if (this.dataConn !== conn) return;
      this.stopHeartbeat();
      this.events.onStatus("error", err.message);
    });
  }

  /** Only the side that originally dialed out redials on failure — matches the pre-group-calls behavior, and avoids both
   *  sides racing to reconnect to each other at once. */
  private tryRedial() {
    if (this.isHost) return; // we didn't dial this peer; wait for them to redial us
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.events.onStatus("error", "Connection lost");
      return;
    }
    this.reconnectAttempts++;
    this.events.onStatus("reconnecting");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.events.onNeedRedial();
    }, RECONNECT_DELAY);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.dataConn?.open) return;
      try { this.dataConn.send({ type: "ping", t: performance.now() }); } catch { /* noop */ }

      const now = performance.now();
      if (now - this.lastRecvAt > this.STALE_TIMEOUT) {
        this.lastRecvAt = now;
        if (this.destroyed) return;
        this.tryRedial();
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  setFpsCap(cap: number) { this.fpsCap = Math.max(5, cap); }
  get currentFps() { return Math.min(this.targetFps, this.fpsCap); }

  isSendDue(): boolean {
    if (!this.dataConn?.open) return false;
    const now = performance.now();
    if (this.lastSentAt > 0 && now - this.lastSentAt < 1000 / this.currentFps - 2) return false;
    return (this.dataConn?.dataChannel?.bufferedAmount ?? 0) <= BUFFERED_AMOUNT_CRITICAL;
  }

  private scratchChars(src: ArrayLike<number>, n: number): Uint8Array {
    if (this.curChars.length !== n) this.curChars = new Uint8Array(n);
    const dst = this.curChars;
    for (let i = 0; i < n; i++) dst[i] = src[i] & 0xff;
    return dst;
  }

  private kindChanged(kind: number): boolean {
    const changed = this.lastKind !== kind;
    this.lastKind = kind;
    return changed;
  }

  /**
   * Scene-change-aware keyframing (Priority 3 roadmap item 7): the fixed `keyframeInterval` (2-6s depending on fps
   * tier) is fine for a steady scene, but a big cut — camera flip, a light switching on, someone stepping into frame —
   * makes the next interval's worth of delta frames expensive to reconstruct correctly (quadtree/ASCII) or visibly wrong
   * until the next scheduled keyframe (video codec). A sparse luma sample taken once per frame catches a frame-wide cut
   * immediately without a second full-frame pass: SCENE_SAMPLES points is enough to reliably flag a global change while
   * staying immune to ordinary local motion — a moving hand or talking face only touches a fraction of the sampled
   * points, which is why the threshold is on the MEAN diff across all samples, not any single one. One shared method so
   * all four frame-send paths (ascii-color, color, adaptive, video) get this for free rather than four copies of it.
   */
  private sceneSamples = new Uint8Array(0);
  private sceneW = 0;
  private sceneH = 0;
  private static readonly SCENE_SAMPLES = 32;
  private static readonly SCENE_CHANGE_THRESHOLD = 40; // mean luma diff (0-255) across sampled points — well above ordinary motion/lighting drift

  private sceneChanged(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): boolean {
    const n = w * h;
    if (n === 0) return false;
    const samples = PeerSession.SCENE_SAMPLES;
    const stride = Math.max(1, Math.floor(n / samples));
    if (this.sceneSamples.length !== samples || this.sceneW !== w || this.sceneH !== h) {
      this.sceneSamples = new Uint8Array(samples);
      this.sceneW = w; this.sceneH = h;
      for (let i = 0, p = 0; i < samples; i++, p += stride) {
        const px = Math.min(n - 1, p) * 4;
        this.sceneSamples[i] = (rgba[px] * 77 + rgba[px + 1] * 150 + rgba[px + 2] * 29) >> 8;
      }
      return false; // first frame at this size — nothing to compare against yet (resize already forces its own keyframe elsewhere)
    }
    let diffSum = 0;
    for (let i = 0, p = 0; i < samples; i++, p += stride) {
      const px = Math.min(n - 1, p) * 4;
      const l = (rgba[px] * 77 + rgba[px + 1] * 150 + rgba[px + 2] * 29) >> 8;
      diffSum += Math.abs(l - this.sceneSamples[i]);
      this.sceneSamples[i] = l;
    }
    return diffSum / samples >= PeerSession.SCENE_CHANGE_THRESHOLD;
  }

  sendAsciiFrame(charIndices: ArrayLike<number>, w: number, h: number, charset: string) {
    if (!this.dataConn?.open) return;
    if (!this.throttle()) return;

    this.frameCount++;
    const N = w * h;
    const forceKeyframe = this.shouldForceKeyframe() || this.kindChanged(1);
    const chars = this.scratchChars(charIndices, N);

    const et0 = performance.now();
    const buf = encodeFrame({
      w, h, charset, colorIndices: null, palette: null, sendPalette: false,
      charIndices: chars, blockColorMode: false,
      prevCharIndices: !forceKeyframe && this.prevSentIndices?.length === N ? this.prevSentIndices : null,
      prevColorIndices: null,
      forceKeyframe,
    });
    recordPerf(sizedBucket("ascii-encode", w, h), performance.now() - et0);
    this.dispatch(buf, chars, null, forceKeyframe);
  }

  sendAsciiColorFrame(
    charIndices: ArrayLike<number>, w: number, h: number, charset: string,
    rgba: Uint8ClampedArray | Uint8Array
  ): { palette: Uint8Array; indices: Uint8Array } | null {
    if (!this.dataConn?.open) return null;
    if (!this.throttle()) return null;

    this.frameCount++;
    const N = w * h;
    let forceKeyframe = this.shouldForceKeyframe(this.sceneChanged(rgba, w, h)) || this.kindChanged(2) || this.prevSentColorIdx?.length !== N || this.prevSentIndices?.length !== N;
    const chars = this.scratchChars(charIndices, N);
    const qt0 = performance.now();
    const q = this.quant.quantize(rgba, N, forceKeyframe, forceKeyframe ? null : this.prevSentColorIdx);
    recordPerf(sizedBucket("quantize", w, h), performance.now() - qt0);
    if (q.rebuilt) forceKeyframe = true;

    const et0 = performance.now();
    const buf = encodeFrame({
      w, h, charset, colorIndices: q.indices, palette: q.palette, sendPalette: forceKeyframe,
      charIndices: chars, blockColorMode: false,
      prevCharIndices: forceKeyframe ? null : this.prevSentIndices,
      prevColorIndices: forceKeyframe ? null : this.prevSentColorIdx,
      forceKeyframe,
    });
    recordPerf(sizedBucket("ascii-color-encode", w, h), performance.now() - et0);
    this.dispatch(buf, chars, q.indices, forceKeyframe);
    return { palette: q.palette, indices: q.indices };
  }

  private shouldForceKeyframe(sceneChange = false): boolean {
    return this.needKeyframe || this.frameCount === 1 || this.frameCount % this.keyframeInterval === 1 || sceneChange;
  }

  sendColorFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, pixelated = false): { palette: Uint8Array; indices: Uint8Array } | null {
    if (!this.dataConn?.open) return null;
    if (!this.throttle()) return null;

    this.frameCount++;
    const N = w * h;
    let forceKeyframe = this.shouldForceKeyframe(this.sceneChanged(rgba, w, h)) || this.kindChanged(pixelated ? 4 : 3) || this.prevSentColorIdx?.length !== N;
    const qt0 = performance.now();
    const q = this.quant.quantize(rgba, N, forceKeyframe, forceKeyframe ? null : this.prevSentColorIdx);
    recordPerf(sizedBucket("quantize", w, h), performance.now() - qt0);
    if (q.rebuilt) forceKeyframe = true;

    const et0 = performance.now();
    const buf = encodeFrame({
      w, h, charset: "", colorIndices: q.indices, palette: q.palette, sendPalette: forceKeyframe,
      charIndices: null, blockColorMode: true, pixelated,
      prevCharIndices: null, prevColorIndices: forceKeyframe ? null : this.prevSentColorIdx,
      forceKeyframe,
    });
    recordPerf(sizedBucket(pixelated ? "pixel-encode" : "color-encode", w, h), performance.now() - et0);
    this.dispatch(buf, null, q.indices, forceKeyframe);
    return { palette: q.palette, indices: q.indices };
  }

  sendAdaptiveFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, pixel = false) {
    if (!this.dataConn?.open) return;
    if (!this.throttle()) return;

    this.frameCount++;
    const forceKeyframe = this.shouldForceKeyframe(this.sceneChanged(rgba, w, h)) || this.kindChanged(pixel ? 6 : 5);
    const qt0 = performance.now();
    const buf = this.adaptEnc.encode(rgba, w, h, Math.round(this.maxFrameSize * 0.8), forceKeyframe, { pixel });
    recordPerf(sizedBucket("quadtree-encode", w, h), performance.now() - qt0);
    this.dispatch(buf, null, null, forceKeyframe);
  }

  /** The codec both sides of THIS session can use for real-video Color mode, or null (→ quadtree codec for this peer). */
  get videoCodec(): VideoCodecId | null {
    if (this.videoDisabled || !this.remoteDec || !this.videoTx.usable) return null;
    for (const id of VIDEO_CODEC_PREFERENCE) if (this.encCodecs.includes(id) && this.remoteDec.includes(id)) return id;
    return null;
  }

  videoPlan(vw: number, vh: number, scale = 1): { w: number; h: number } | null {
    if (this.videoCodec === null || !this.dataConn?.open) return null;
    return videoDims(vw, vh, Math.max(96, Math.round(VIDEO_TIERS[this.qualityLevel].long * scale / 16) * 16));
  }

  sendVideoFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): boolean {
    const codec = this.videoCodec;
    if (codec === null || !this.dataConn?.open) return false;
    if (!this.throttle()) return true;

    this.frameCount++;
    const forceKey = this.needKeyframe || this.kindChanged(7) || this.frameCount === 1 || this.frameCount % 150 === 1 || this.sceneChanged(rgba, w, h);
    const tier = VIDEO_TIERS[this.qualityLevel];
    if (this.videoTx.encode(rgba, w, h, codec, tier.bitrate, this.targetFps, forceKey) && forceKey) this.needKeyframe = false;
    return true;
  }

  private dispatchVideo(buf: ArrayBuffer, key: boolean) {
    if (!this.dataConn?.open) return;
    const buffered = this.dataConn.dataChannel?.bufferedAmount ?? 0;
    if (buffered > BUFFERED_AMOUNT_CRITICAL) {
      this.recentDrops++; this.needKeyframe = true;
    } else {
      this.recentSends++;
      try {
        this.dataConn.send(buf);
        if (key) this.framesSinceKey = 0; else this.framesSinceKey++;
        this.consecutiveDrops = 0;
      } catch { this.recentDrops++; this.needKeyframe = true; }
    }
    this.qualityCheckCounter++;
    if (this.qualityCheckCounter >= this.CHECK_FRAMES) { this.adaptQuality(); this.qualityCheckCounter = 0; this.recentSends = 0; this.recentDrops = 0; }
  }

  private throttle(): boolean {
    const now = performance.now();
    const minInterval = 1000 / this.currentFps - 2;
    if (this.lastSentAt > 0 && now - this.lastSentAt < minInterval) return false;

    const buffered = this.dataConn?.dataChannel?.bufferedAmount ?? 0;
    if (buffered > BUFFERED_AMOUNT_CRITICAL) { this.recentDrops++; return false; }

    this.lastSentAt = now;
    return true;
  }

  private keep(slot: Uint8Array | null, src: Uint8Array): Uint8Array {
    if (!slot || slot.length !== src.length) return new Uint8Array(src);
    slot.set(src);
    return slot;
  }

  private dispatch(buf: ArrayBuffer, charIndices: Uint8Array | null, colorIndices: Uint8Array | null, forceKeyframe: boolean) {
    if (!this.dataConn) return;

    if (buf.byteLength > this.maxFrameSize && !forceKeyframe) {
      this.recentDrops++;
      this.qualityCheckCounter++;
      if (++this.consecutiveDrops >= 4) { this.consecutiveDrops = 0; this.setQuality(QUALITY_ORDER[Math.max(0, QUALITY_ORDER.indexOf(this.qualityLevel) - 1)]); }
      if (this.qualityCheckCounter >= this.CHECK_FRAMES) { this.adaptQuality(); this.qualityCheckCounter = 0; this.recentSends = 0; this.recentDrops = 0; }
      return;
    }

    this.recentSends++;

    try {
      this.dataConn.send(buf);
      this.prevSentIndices   = charIndices ? this.keep(this.prevSentIndices, charIndices) : null;
      this.prevSentColorIdx  = colorIndices ? this.keep(this.prevSentColorIdx, colorIndices) : null;
      this.consecutiveDrops = 0;
      if (forceKeyframe) { this.needKeyframe = false; this.framesSinceKey = 0; } else this.framesSinceKey++;
    } catch {
      this.recentDrops++;
      this.needKeyframe = true;
    }

    this.qualityCheckCounter++;
    if (this.qualityCheckCounter >= this.CHECK_FRAMES) {
      this.adaptQuality();
      this.qualityCheckCounter = 0;
      this.recentSends = 0;
      this.recentDrops = 0;
    }
  }

  sendState(micMuted: boolean, camOff: boolean) {
    if (!this.dataConn?.open) return;
    try { this.dataConn.send({ type: "state", micMuted, camOff }); } catch { /* noop */ }
  }

  hangup() {
    this.destroyed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.pendingIncomingCall = null;
    this.adaptEnc.reset(); this.adaptDec.reset();
    this.videoTx.reset(); this.videoRx.reset();
    try { this.dataConn?.close(); }  catch { /* noop */ }
    try { this.mediaConn?.close(); } catch { /* noop */ }
    this.dataConn  = null;
    this.mediaConn = null;
  }

  getQualityLevel(): CallQualityLevel { return this.qualityLevel; }
  getStats() {
    return {
      quality: this.qualityLevel, fps: this.targetFps, keyframeInterval: this.keyframeInterval,
      latency: Math.round(this.rtt), drops: this.recentDrops,
      // null = this peer pairing is on the quadtree codec (either side lacks WebCodecs, no shared codec, or an
      // encode/decode error fell back) — exposed so it's visible which pipeline (and which perfStats buckets:
      // decode-readback+receive-enhance vs receive-enhance-only) actually applies to a given call.
      videoCodec: this.videoCodec,
      // For diagnosing why videoCodec might be null: this browser's own encodable codecs vs. what the remote side told
      // us it can decode (received once over the data channel as a "caps" message, see attachData()).
      localEncoders: this.encCodecs,
      remoteDecoders: this.remoteDec,
    };
  }
  get isConnected() { return !!this.dataConn?.open; }
}

/**
 * Owns the one shared signaling `Peer` plus one `PeerSession` per remote participant (mesh: everyone connects directly to
 * everyone, capped at MAX_REMOTE_PEERS, no media server). All the old single-peer behavior still lives in PeerSession
 * unchanged — this class is just the part that's actually new: deciding *which* session a piece of work belongs to, and
 * fanning frame-sends out to all of them.
 */
export class CallManager {
  private peer: Peer | null = null;
  private sessions = new Map<string, PeerSession>();
  private events: CallManagerEvents;
  private localStream: MediaStream | null = null;

  private myId = "";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private encCodecs: VideoCodecId[] = [];
  private encProbe: Promise<void> | null = null;

  constructor(events: CallManagerEvents) {
    this.events = events;
    if (webCodecsAvailable()) this.encProbe = probeEncoders().then(c => { this.encCodecs = c; }).catch(() => {});
  }

  private sessionEvents(peerId: string): SessionEvents {
    return {
      onStatus: (s, d) => this.events.onStatus(peerId, s, d),
      onRemoteFrame: f => this.events.onRemoteFrame(peerId, f),
      onRemoteHangup: () => { this.events.onRemoteHangup(peerId); this.sessions.delete(peerId); },
      onRemoteStream: s => this.events.onRemoteStream(peerId, s),
      onRemoteState: s => this.events.onRemoteState?.(peerId, s),
      onQualityChange: (lvl, step) => this.events.onQualityChange?.(peerId, lvl, step),
      onNeedRedial: () => {
        if (this.destroyed || !this.peer) return;
        const session = this.sessions.get(peerId);
        if (!session) return;
        session.hangup();
        const fresh = new PeerSession(peerId, false, this.encCodecs, this.sessionEvents(peerId));
        this.sessions.set(peerId, fresh);
        fresh.connect(this.peer, this.localStream);
      },
    };
  }

  private createSession(peerId: string, isHost: boolean): PeerSession {
    const session = new PeerSession(peerId, isHost, this.encCodecs, this.sessionEvents(peerId));
    this.sessions.set(peerId, session);
    return session;
  }

  async start(): Promise<string> {
    this.destroyed = false;
    const iceServers = await fetchIceServers();
    if (this.destroyed) throw new Error("destroyed");
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: { iceServers }, debug: 1 });
      this.peer = peer;

      const timeout = setTimeout(() => reject(new Error("Signaling timeout")), 10000);

      peer.on("open", id => {
        clearTimeout(timeout);
        this.myId = id;
        this.events.onStatus("", "waiting", id);
        resolve(id);
      });

      peer.on("connection", conn => {
        const remoteId = conn.peer;
        if (!this.sessions.has(remoteId) && this.sessions.size >= MAX_REMOTE_PEERS) {
          this.events.onRoomFull?.(remoteId);
          try { conn.close(); } catch { /* noop */ }
          return;
        }
        const session = this.sessions.get(remoteId) ?? this.createSession(remoteId, true);
        session.attachData(conn);
      });

      peer.on("call", call => {
        const remoteId = call.peer;
        if (!this.sessions.has(remoteId) && this.sessions.size >= MAX_REMOTE_PEERS) {
          this.events.onRoomFull?.(remoteId);
          try { call.close(); } catch { /* noop */ }
          return;
        }
        const session = this.sessions.get(remoteId) ?? this.createSession(remoteId, true);
        session.attachIncomingCall(call, this.localStream);
      });

      peer.on("disconnected", () => {
        if (this.destroyed) return;
        this.events.onStatus("", "reconnecting");
        try { peer.reconnect(); } catch { /* noop */ }
      });

      peer.on("error", err => {
        clearTimeout(timeout);
        if (this.peer === peer && !this.destroyed) {
          this.handlePeerError(err);
        }
        reject(err);
      });

      peer.on("close", () => {
        if (!this.destroyed) this.events.onStatus("", "error", "Signaling closed");
      });
    });
  }

  private handlePeerError(err: { type?: string; message?: string }) {
    const recoverable = err.type === "network" || err.type === "server-error" || err.type === "socket-error" || err.type === "socket-closed";
    if (recoverable && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      this.events.onStatus("", "reconnecting", err.message);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (!this.destroyed) this.rejoinSignaling();
      }, RECONNECT_DELAY * this.reconnectAttempts);
    } else {
      this.events.onStatus("", "error", err.message ?? "Connection error");
    }
  }

  /** The signaling Peer object itself died (not just one leg) — restart it, then redial everyone we originally dialed out
   *  to. Participants who dialed *us* can't be redialed by us; they'll reconnect once our new id reaches them, which (same
   *  as before group calls existed) only happens via the room record, not automatically — a known, pre-existing limit. */
  private rejoinSignaling() {
    if (this.peer && !this.peer.destroyed) return;
    const oldId = this.myId;
    const remoteIds = [...this.sessions.keys()];
    this.start().then(newId => {
      if (newId !== oldId) this.events.onIdChanged?.(newId, oldId);
      for (const id of remoteIds) this.connectTo(id, this.localStream);
    }).catch(() => { /* surfaced via onStatus already */ });
  }

  /** Call once the camera/mic stream is ready — answers any calls that arrived before it was, and lets future incoming calls answer immediately. */
  answerWithStream(stream: MediaStream) {
    this.localStream = stream;
    for (const session of this.sessions.values()) session.answerWithStream(stream);
  }

  /** Connect to one more participant (host-side: calling out to a newly-joined guest; guest-side: calling out to everyone
   *  already in the room). A no-op past the cap, and a no-op if we're already connected to them. */
  connectTo(remoteId: string, stream: MediaStream | null) {
    if (!this.peer) return;
    const id = remoteId.trim();
    if (!id || id === this.myId) return;
    this.localStream = stream;
    const existing = this.sessions.get(id);
    if (existing?.isConnected) return;
    if (!existing && this.sessions.size >= MAX_REMOTE_PEERS) return;
    const session = existing ?? this.createSession(id, false);
    session.connect(this.peer, stream);
  }

  /** Convenience for joining a room with several people already in it. */
  connectToAll(remoteIds: string[], stream: MediaStream | null) {
    for (const id of remoteIds) this.connectTo(id, stream);
  }

  get participantIds(): string[] { return [...this.sessions.keys()]; }
  get participantCount(): number { return this.sessions.size; }
  get roomFull(): boolean { return this.sessions.size >= MAX_REMOTE_PEERS; }

  /** Drop one participant without ending the call for everyone else. */
  hangupPeer(peerId: string) {
    this.sessions.get(peerId)?.hangup();
    this.sessions.delete(peerId);
  }

  // ── Broadcast sends: every mode fans its frame out to every currently-connected session. Each session quantizes/encodes
  // independently (see the PeerSession class doc comment) — this is the real per-participant CPU cost of a mesh call.

  sendAsciiFrame(charIndices: ArrayLike<number>, w: number, h: number, charset: string) {
    for (const s of this.sessions.values()) s.sendAsciiFrame(charIndices, w, h, charset);
  }

  /** Returns the first session's encoded result (purely so the local self-preview has something to paint) — what's actually
   *  sent to each peer is still encoded independently inside the loop. */
  sendAsciiColorFrame(
    charIndices: ArrayLike<number>, w: number, h: number, charset: string, rgba: Uint8ClampedArray | Uint8Array
  ): { palette: Uint8Array; indices: Uint8Array } | null {
    let first: { palette: Uint8Array; indices: Uint8Array } | null = null;
    for (const s of this.sessions.values()) {
      const r = s.sendAsciiColorFrame(charIndices, w, h, charset, rgba);
      if (!first) first = r;
    }
    return first;
  }

  sendColorFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, pixelated = false): { palette: Uint8Array; indices: Uint8Array } | null {
    let first: { palette: Uint8Array; indices: Uint8Array } | null = null;
    for (const s of this.sessions.values()) {
      const r = s.sendColorFrame(rgba, w, h, pixelated);
      if (!first) first = r;
    }
    return first;
  }

  sendAdaptiveFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, pixel = false) {
    for (const s of this.sessions.values()) s.sendAdaptiveFrame(rgba, w, h, pixel);
  }

  /** Only when EVERY connected session can do real video — one captured frame has to serve all of them, and a session
   *  stuck on the quadtree codec can't use a video-shaped frame. Mixed capability falls everyone back to the quadtree
   *  codec instead, rather than needing two differently-sized captures per render tick. */
  videoPlan(vw: number, vh: number, scale = 1): { w: number; h: number } | null {
    const open = [...this.sessions.values()].filter(s => s.isConnected);
    if (open.length === 0) return null;
    for (const s of open) if (s.videoCodec === null) return null;
    let w = Infinity, h = Infinity;
    for (const s of open) {
      const p = s.videoPlan(vw, vh, scale);
      if (!p) return null;
      w = Math.min(w, p.w); h = Math.min(h, p.h);
    }
    return { w, h };
  }

  sendVideoFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): boolean {
    let any = false;
    for (const s of this.sessions.values()) if (s.sendVideoFrame(rgba, w, h)) any = true;
    return any;
  }

  sendState(micMuted: boolean, camOff: boolean) {
    for (const s of this.sessions.values()) s.sendState(micMuted, camOff);
  }

  /** The render loop fires whenever ANY connected session wants a frame; sessions that don't yet (a slower/more congested
   *  peer) self-throttle their own send — unchanged from the single-peer version, just per-session now. */
  isSendDue(): boolean {
    for (const s of this.sessions.values()) if (s.isSendDue()) return true;
    return false;
  }

  setFpsCap(cap: number) { for (const s of this.sessions.values()) s.setFpsCap(cap); }
  get currentFps(): number {
    let min = Infinity;
    for (const s of this.sessions.values()) min = Math.min(min, s.currentFps);
    return Number.isFinite(min) ? min : 30;
  }

  /** The most conservative quality level across all connected peers — used only to decide how hard to push the shared
   *  capture resolution; each session still separately adapts its own actual send quality. */
  getQualityLevel(): CallQualityLevel {
    let worst = QUALITY_ORDER.length - 1;
    for (const s of this.sessions.values()) worst = Math.min(worst, QUALITY_ORDER.indexOf(s.getQualityLevel()));
    return QUALITY_ORDER[Math.max(0, worst)];
  }

  getMyId(): string { return this.myId; }

  getStats() {
    const per: Record<string, ReturnType<PeerSession["getStats"]>> = {};
    for (const [id, s] of this.sessions) per[id] = s.getStats();
    return per;
  }

  hangup() {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.reconnectAttempts = 0;
    for (const s of this.sessions.values()) s.hangup();
    this.sessions.clear();
    try { this.peer?.destroy(); } catch { /* noop */ }
    this.peer = null;
  }

  get isConnected(): boolean {
    for (const s of this.sessions.values()) if (s.isConnected) return true;
    return false;
  }
}
