import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import {
  encodeFrame, decode, toArrayBuffer, mapToPalette, generatePalette,
  buildAdaptivePalette, PaletteMapper, type RemoteFrame,
} from "./binary";

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

export type CallQualityLevel = "low" | "medium" | "high" | "ultra" | "max";

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
const QUALITY_STEPS: Record<CallQualityLevel, CallQualityStep> = {
  low:    { keyframeInterval: 60, targetFps: 10, maxFrameSize: 6000,  resScale: 0.5  },
  medium: { keyframeInterval: 60, targetFps: 15, maxFrameSize: 12000, resScale: 0.7  },
  high:   { keyframeInterval: 60, targetFps: 20, maxFrameSize: 24000, resScale: 0.85 },
  ultra:  { keyframeInterval: 60, targetFps: 24, maxFrameSize: 40000, resScale: 1.0  },
  max:    { keyframeInterval: 60, targetFps: 30, maxFrameSize: 60000, resScale: 1.0  },
};

const QUALITY_ORDER: CallQualityLevel[] = ["low", "medium", "high", "ultra", "max"];

const BUFFERED_AMOUNT_LOW_THRESHOLD = 96 * 1024;
const BUFFERED_AMOUNT_CRITICAL = 1024 * 1024;


export interface CallManagerEvents {
  onStatus: (status: CallStatus, detail?: string) => void;
  onRemoteFrame: (frame: RemoteFrame) => void;
  onRemoteHangup: () => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteState?: (state: RemoteState) => void;
  onQualityChange?: (level: CallQualityLevel, step: CallQualityStep) => void;
  onIdChanged?: (newId: string, oldId: string) => void;
}

export type CallStatus = "idle" | "waiting" | "connecting" | "connected" | "reconnecting" | "closed" | "error";

export interface RemoteState {
  micMuted: boolean;
  camOff: boolean;
}

export class CallManager {
  private peer: Peer | null = null;
  private dataConn: DataConnection | null = null;
  private mediaConn: MediaConnection | null = null;
  private events: CallManagerEvents;
  private localStream: MediaStream | null = null;
  private pendingIncomingCall: MediaConnection | null = null;

  private myId = "";
  private remoteId: string | null = null;
  private isHost = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private prevSentIndices: Uint8Array | null = null;
  private prevSentColorIdx: Uint8Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private mapper = new PaletteMapper();
  private framesSinceKey = 0;
  private needKeyframe = true;
  private lastKfRequestAt = 0;
  private rtt = 0;
  private rttBase = 0;
  private rttSamples: number[] = [];
  private consecutiveDrops = 0;
  private frameCount = 0;
  // Starting at "ultra" (48fps, full resolution, the biggest frames) meant
  // every call began by blasting the most demanding setting a phone's
  // single-threaded JS + data channel could possibly sustain, before any
  // congestion signal existed to say otherwise. That's backwards — it
  // guarantees an overload spike (dropped/late frames, CPU-starved
  // encoding) right at connect, which is also exactly when adaptQuality()
  // has the least data (consecutiveGood/Bad both start at 0) to react
  // quickly. Starting at "medium" and letting adaptQuality() ramp UP once
  // conditions are confirmed good (2 consecutive healthy checks) is far
  // more stable than starting high and only reacting after things are
  // already struggling.
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

  // iceStateChanged only fires when the browser itself notices the
  // RTCPeerConnection changed state (failed/disconnected). It does NOT
  // cover the common "silent hang" case: a NAT rebinding, a backgrounded
  // tab whose radio drops the link, or a corporate firewall that starts
  // quietly dropping UDP packets mid-call — the connection can keep
  // reporting "connected" while literally nothing gets through. A small
  // heartbeat (sent even when the camera is off and no real frames are
  // flowing) plus a last-received-anything timestamp lets us detect that
  // case ourselves instead of hanging forever with a "connected" UI.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecvAt = 0;
  private readonly HEARTBEAT_INTERVAL = 1000;
  private readonly STALE_TIMEOUT = 9000;

  constructor(events: CallManagerEvents) {
    this.events = events;
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
        this.events.onStatus("waiting", id);
        resolve(id);
      });

      peer.on("connection", conn => {
        this.isHost = true;
        this.remoteId = conn.peer;
        this.attachData(conn);
      });

      peer.on("call", call => {
        this.mediaConn = call;
        this.remoteId = call.peer;
        this.isHost = true;
        this.attachMedia(call);
        if (this.localStream) {
          call.answer(audioOnly(this.localStream));
        } else {
          this.pendingIncomingCall = call;
        }
      });

      peer.on("disconnected", () => {
        if (this.destroyed) return;
        this.events.onStatus("reconnecting");
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
        if (!this.destroyed) this.events.onStatus("error", "Signaling closed");
      });
    });
  }

  private handlePeerError(err: { type?: string; message?: string }) {
    const recoverable = err.type === "network" || err.type === "server-error" || err.type === "socket-error" || err.type === "socket-closed";
    if (recoverable && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      this.events.onStatus("reconnecting", err.message);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        if (!this.destroyed) this.rejoin();
      }, RECONNECT_DELAY * this.reconnectAttempts);
    } else {
      this.events.onStatus("error", err.message ?? "Connection error");
    }
  }

  private rejoin() {
    if (!this.peer || this.peer.destroyed) {
      const oldId = this.myId;
      this.start().then(newId => {
        if (newId !== oldId) this.events.onIdChanged?.(newId, oldId);
        if (this.remoteId) this.connectTo(this.remoteId, this.localStream);
      }).catch(() => { /* surfaced via onStatus already */ });
      return;
    }
    if (this.remoteId && !this.isHost) {
      try { this.dataConn?.close(); }  catch { /* noop */ }
      try { this.mediaConn?.close(); } catch { /* noop */ }
      this.dataConn  = null;
      this.mediaConn = null;
      this.connectTo(this.remoteId, this.localStream);
    }
  }

  answerWithStream(stream: MediaStream) {
    this.localStream = stream;
    if (this.pendingIncomingCall) {
      const call = this.pendingIncomingCall;
      this.pendingIncomingCall = null;
      call.answer(audioOnly(stream));
    } else if (this.mediaConn && this.mediaConn.open === false) {
      this.mediaConn.answer(audioOnly(stream));
    }
  }

  connectTo(remoteId: string, stream: MediaStream | null) {
    if (!this.peer) return;
    const id = remoteId.trim();
    this.isHost = false;
    this.remoteId = id;
    this.events.onStatus("connecting", id);
    this.localStream = stream;

    const conn = this.peer.connect(id, { reliable: true, serialization: "binary" });
    this.attachData(conn);

    if (stream) {
      const call = this.peer.call(id, audioOnly(stream));
      this.mediaConn = call;
      this.attachMedia(call);
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

    // RTT rides the same ordered channel as the frames, so it includes our own send-queue delay — a real congestion signal,
    // unlike timing a synchronous send() (which is always ~0).
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
    this.events.onQualityChange?.(level, step);
  }

  private attachMedia(call: MediaConnection) {
    call.on("stream", s => this.events.onRemoteStream(s));
    call.on("close", () => this.events.onRemoteHangup());
    call.on("error", () => {
      this.mediaConn = null;
    });
    call.on("iceStateChanged", state => {
      if (state === "failed") {
        try { call.close(); } catch { /* noop */ }
      }
    });
  }

  private attachData(conn: DataConnection) {
    this.dataConn = conn;

    conn.on("open", () => {
      this.reconnectAttempts = 0;
      this.events.onStatus("connected");
      this.receivedKeyframe = false;
      this.prevRecvFrame    = null;
      this.lastRecvAt       = performance.now();
      this.startHeartbeat();
    });

    conn.on("data", (data: unknown) => {
      this.lastRecvAt = performance.now();

      if (data && typeof data === "object" && "type" in (data as Record<string, unknown>) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
        const m = data as { type: string; t?: number; micMuted?: boolean; camOff?: boolean };
        if (m.type === "ping") { try { conn.send({ type: "pong", t: m.t }); } catch { /* noop */ } return; }
        if (m.type === "pong") { if (typeof m.t === "number") this.onRtt(performance.now() - m.t); return; }
        if (m.type === "kf") { this.needKeyframe = true; return; }
        if (m.type === "state") {
          this.events.onRemoteState?.({ micMuted: !!m.micMuted, camOff: !!m.camOff });
          return;
        }
        return;
      }

      const buf = toArrayBuffer(data);
      if (buf) {
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
      if (this.destroyed) return;
      if (state === "disconnected") {
        this.events.onStatus("reconnecting");
      } else if (state === "failed") {
        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempts++;
          this.events.onStatus("reconnecting");
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (!this.destroyed) this.rejoin();
          }, RECONNECT_DELAY);
        } else {
          this.events.onStatus("error", "Connection lost");
        }
      } else if (state === "connected" || state === "completed") {
        this.reconnectAttempts = 0;
        if (this.dataConn?.open) this.events.onStatus("connected");
      }
    });

    conn.on("close", () => {
      this.stopHeartbeat();
      if (!this.destroyed) this.events.onStatus("closed");
    });
    conn.on("error", err => {
      this.stopHeartbeat();
      this.events.onStatus("error", err.message);
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.dataConn?.open) return;
      try { this.dataConn.send({ type: "ping", t: performance.now() }); } catch { /* noop — next tick or iceStateChanged will catch a truly dead channel */ }

      const now = performance.now();
      if (now - this.lastRecvAt > this.STALE_TIMEOUT) {
        // Nothing — not a video frame, a state update, nor the peer's own
        // ping — has come through in STALE_TIMEOUT ms, despite the data
        // channel reporting itself open. Treat this the same way a
        // "failed" iceStateChanged is treated: reconnect if we still have
        // attempts left, otherwise surface it as a lost connection.
        this.lastRecvAt = now; // reset so we don't refire every tick while rejoin() works
        if (this.destroyed) return;
        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempts++;
          this.events.onStatus("reconnecting");
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (!this.destroyed) this.rejoin();
          }, RECONNECT_DELAY);
        } else {
          this.events.onStatus("error", "Connection lost");
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** True when a new frame should be produced now. Callers check this BEFORE doing capture/convert work, so no CPU is spent on frames that would be throttled away. */
  isSendDue(): boolean {
    if (!this.dataConn?.open) return false;
    const now = performance.now();
    if (this.lastSentAt > 0 && now - this.lastSentAt < 1000 / this.targetFps - 2) return false;
    return (this.dataConn?.dataChannel?.bufferedAmount ?? 0) <= BUFFERED_AMOUNT_CRITICAL;
  }

  /** ASCII mode — sends character indices, optionally with per-cell color. */
  sendAsciiFrame(
    charIndices: ArrayLike<number>,
    w: number, h: number,
    charset: string,
    rgbColors: Uint8Array | null
  ) {
    if (!this.dataConn?.open) return;
    if (!this.throttle()) return;

    this.frameCount++;
    const forceKeyframe = this.shouldForceKeyframe();
    const N = w * h;
    const chars = charIndices instanceof Uint8Array ? charIndices : Uint8Array.from(charIndices as ArrayLike<number>);

    let colorIndices: Uint8Array | null = null;
    let palette: Uint8Array | null = null;
    if (rgbColors && rgbColors.length === N * 3) {
      const r = new Uint8Array(N), g = new Uint8Array(N), b = new Uint8Array(N);
      for (let i = 0; i < N; i++) { r[i] = rgbColors[i * 3]; g[i] = rgbColors[i * 3 + 1]; b[i] = rgbColors[i * 3 + 2]; }
      colorIndices = mapToPalette(r, g, b);
      palette = generatePalette(256);
    }

    const prevChar  = !forceKeyframe && this.prevSentIndices?.length === N ? this.prevSentIndices : null;
    const prevColor = !forceKeyframe && this.prevSentColorIdx?.length === N ? this.prevSentColorIdx : null;

    const buf = encodeFrame({
      w, h, charset, colorIndices, palette, sendPalette: forceKeyframe && !!palette,
      charIndices: chars, blockColorMode: false,
      prevCharIndices: prevChar, prevColorIndices: prevColor,
      forceKeyframe,
    });

    this.dispatch(buf, chars, colorIndices, forceKeyframe);
  }

  private shouldForceKeyframe(): boolean {
    const force = this.needKeyframe || this.frameCount === 1 || this.frameCount % this.keyframeInterval === 1;
    return force;
  }

  /** Color-block mode — sends only color data. rgba is w*h*4 RGBA bytes (alpha ignored). */
  sendColorFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number) {
    if (!this.dataConn?.open) return;
    if (!this.throttle()) return;

    this.frameCount++;
    const N = w * h;
    let forceKeyframe = this.shouldForceKeyframe() || !this.mapper.ready || this.prevSentColorIdx?.length !== N;
    const out = new Uint8Array(N);

    if (!forceKeyframe) {
      this.mapper.map(rgba, N, this.prevSentColorIdx, 324, out);
      // Palette has drifted (lighting change, new scene): rebuild it as a keyframe rather than smearing 256 stale colors.
      if (this.mapper.lastRms > 26 && this.framesSinceKey >= 8) forceKeyframe = true;
    }
    if (forceKeyframe) {
      this.mapper.setPalette(buildAdaptivePalette(rgba, N));
      this.mapper.map(rgba, N, null, 0, out);
    }

    const prevColor = !forceKeyframe ? this.prevSentColorIdx : null;
    const buf = encodeFrame({
      w, h, charset: "", colorIndices: out, palette: this.mapper.palette, sendPalette: forceKeyframe,
      charIndices: null, blockColorMode: true,
      prevCharIndices: null, prevColorIndices: prevColor,
      forceKeyframe,
    });

    this.dispatch(buf, null, out, forceKeyframe);
  }

  private throttle(): boolean {
    const now = performance.now();
    const minInterval = 1000 / this.targetFps;
    if (this.lastSentAt > 0 && now - this.lastSentAt < minInterval) return false;

    const buffered = this.dataConn?.dataChannel?.bufferedAmount ?? 0;
    if (buffered > BUFFERED_AMOUNT_CRITICAL) { this.recentDrops++; return false; }

    this.lastSentAt = now;
    return true;
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

      this.prevSentIndices   = charIndices ? new Uint8Array(charIndices) : null;
      this.prevSentColorIdx  = colorIndices ? new Uint8Array(colorIndices) : null;
      this.consecutiveDrops = 0;
      if (forceKeyframe) { this.needKeyframe = false; this.framesSinceKey = 0; } else this.framesSinceKey++;
    } catch {
      this.recentDrops++;
      this.needKeyframe = true; // sender/receiver bases may now disagree — resync with a full frame
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
    this.reconnectAttempts = 0;
    this.remoteId = null;
    this.pendingIncomingCall = null;
    this.prevSentIndices = null;
    this.prevSentColorIdx = null;
    this.prevRecvFrame = null;
    this.frameCount = 0;
    try { this.dataConn?.close(); }  catch { /* noop */ }
    try { this.mediaConn?.close(); } catch { /* noop */ }
    try { this.peer?.destroy(); }    catch { /* noop */ }
    this.dataConn  = null;
    this.mediaConn = null;
    this.peer      = null;
  }

  setTargetFps(fps: number) { this.targetFps = Math.max(5, Math.min(60, fps)); }
  getQualityLevel(): CallQualityLevel { return this.qualityLevel; }
  getMyId(): string { return this.myId; }

  getStats() {
    return {
      quality: this.qualityLevel,
      fps: this.targetFps,
      keyframeInterval: this.keyframeInterval,
      latency: Math.round(this.rtt),
      drops: this.recentDrops,
    };
  }

  get isConnected() { return !!this.dataConn?.open; }
}
