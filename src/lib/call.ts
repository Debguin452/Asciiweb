import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import { encodeFrame, decode, toArrayBuffer, mapToPalette, generatePalette, type RemoteFrame } from "./binary";
import {
  isWasmAvailable, writePixelsToWasm, wasmMapToPalette, readWasmColorIndices,
  wasmGeneratePalette, readWasmPalette,
} from "./wasm-wrapper";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

const RECONNECT_DELAY = 1500;
const MAX_RECONNECT_ATTEMPTS = 5;

export type CallQualityLevel = "low" | "medium" | "high" | "ultra" | "max";

export interface CallQualityStep {
  keyframeInterval: number;
  targetFps: number;
  maxFrameSize: number; // bytes; a single frame over this is skipped rather than sent
}

const QUALITY_STEPS: Record<CallQualityLevel, CallQualityStep> = {
  low:    { keyframeInterval: 90, targetFps: 12, maxFrameSize: 4000  },
  medium: { keyframeInterval: 60, targetFps: 24, maxFrameSize: 8000  },
  high:   { keyframeInterval: 45, targetFps: 36, maxFrameSize: 16000 },
  ultra:  { keyframeInterval: 30, targetFps: 48, maxFrameSize: 32000 },
  max:    { keyframeInterval: 24, targetFps: 60, maxFrameSize: 65000 },
};

const QUALITY_ORDER: CallQualityLevel[] = ["low", "medium", "high", "ultra", "max"];

const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;
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
  private frameCount = 0;
  private keyframeInterval = QUALITY_STEPS.ultra.keyframeInterval;
  private lastSentAt = 0;
  private targetFps = QUALITY_STEPS.ultra.targetFps;
  private maxFrameSize = QUALITY_STEPS.ultra.maxFrameSize;

  private receivedKeyframe = false;

  private qualityLevel: CallQualityLevel = "ultra";
  private recentSends = 0;
  private recentDrops = 0;
  private recentLatencies: number[] = [];
  private qualityCheckCounter = 0;
  private consecutiveGood = 0;
  private consecutiveBad = 0;
  private readonly CHECK_FRAMES = 15;

  constructor(events: CallManagerEvents) {
    this.events = events;
  }

  async start(): Promise<string> {
    this.destroyed = false;
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: { iceServers: ICE_SERVERS }, debug: 1 });
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
          call.answer(this.localStream);
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
      call.answer(stream);
    } else if (this.mediaConn && this.mediaConn.open === false) {
      this.mediaConn.answer(stream);
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
      const call = this.peer.call(id, stream);
      this.mediaConn = call;
      this.attachMedia(call);
    }
  }

  private adaptQuality() {
    const dropRate   = this.recentSends > 0 ? this.recentDrops / this.recentSends : 0;
    const avgLatency = this.recentLatencies.length > 0
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
      : 0;
    const buffered = this.dataConn?.dataChannel?.bufferedAmount ?? 0;

    const idx = QUALITY_ORDER.indexOf(this.qualityLevel);
    if (idx === -1) return;

    const congested = buffered > BUFFERED_AMOUNT_LOW_THRESHOLD || dropRate > 0.15 || avgLatency > 150;
    const healthy   = buffered === 0 && dropRate < 0.03 && avgLatency < 60;

    if (congested && idx > 0) {
      this.consecutiveBad++;
      this.consecutiveGood = 0;
      const severe = buffered > BUFFERED_AMOUNT_CRITICAL;
      if (this.consecutiveBad >= (severe ? 1 : 2)) {
        const next = QUALITY_ORDER[Math.max(0, idx - (severe ? 2 : 1))];
        this.setQuality(next);
        this.consecutiveBad = 0;
      }
    } else if (healthy && idx < QUALITY_ORDER.length - 1) {
      this.consecutiveGood++;
      this.consecutiveBad = 0;
      if (this.consecutiveGood >= 2) {
        this.consecutiveGood = 0;
        this.setQuality(QUALITY_ORDER[idx + 1]);
      }
    } else {
      this.consecutiveBad = 0;
      this.consecutiveGood = 0;
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
    });

    conn.on("data", (data: unknown) => {
      if (data && typeof data === "object" && "type" in (data as Record<string, unknown>)) {
        const st = data as { type: string; micMuted: boolean; camOff: boolean };
        if (st.type === "state") {
          this.events.onRemoteState?.({ micMuted: st.micMuted, camOff: st.camOff });
          return;
        }
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
      if (!this.destroyed) this.events.onStatus("closed");
    });
    conn.on("error", err => this.events.onStatus("error", err.message));
  }

  /** ASCII mode — sends character indices, optionally with per-cell color. */
  sendAsciiFrame(
    charIndices: Uint8Array,
    w: number, h: number,
    charset: string,
    rgbColors: Uint8Array | null
  ) {
    if (!this.dataConn?.open) return;
    if (!this.throttle()) return;

    this.frameCount++;
    const forceKeyframe = this.frameCount === 1 || this.frameCount % this.keyframeInterval === 1;

    const N = w * h;
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
      w, h, charset, colorIndices, palette,
      charIndices, blockColorMode: false,
      prevCharIndices: prevChar, prevColorIndices: prevColor,
      forceKeyframe,
    });

    this.dispatch(buf, charIndices, colorIndices, forceKeyframe);
  }

  /** Color-block mode — sends only color data, no character indices at all. rgba is a Uint8ClampedArray/Uint8Array of w*h*4 RGBA bytes (alpha ignored). */
  sendColorFrame(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number) {
    if (!this.dataConn?.open) return;
    if (!this.throttle()) return;

    this.frameCount++;
    const forceKeyframe = this.frameCount === 1 || this.frameCount % this.keyframeInterval === 1;
    const N = w * h;

    let colorIndices: Uint8Array;
    let palette: Uint8Array | null = null;

    if (isWasmAvailable()) {
      try {
        writePixelsToWasm(rgba, N);
        wasmMapToPalette(w, h);
        colorIndices = new Uint8Array(readWasmColorIndices(N)); // copy out — readWasm* views are only valid until the next WASM call
        if (forceKeyframe) {
          wasmGeneratePalette();
          palette = readWasmPalette();
        }
      } catch {
        colorIndices = this.colorIndicesFromRgbaJs(rgba, N);
        if (forceKeyframe) palette = generatePalette(256);
      }
    } else {
      colorIndices = this.colorIndicesFromRgbaJs(rgba, N);
      if (forceKeyframe) palette = generatePalette(256);
    }

    const prevColor = !forceKeyframe && this.prevSentColorIdx?.length === N ? this.prevSentColorIdx : null;

    const buf = encodeFrame({
      w, h, charset: "", colorIndices, palette,
      charIndices: null, blockColorMode: true,
      prevCharIndices: null, prevColorIndices: prevColor,
      forceKeyframe,
    });

    this.dispatch(buf, null, colorIndices, forceKeyframe);
  }

  private colorIndicesFromRgbaJs(rgba: Uint8ClampedArray | Uint8Array, N: number): Uint8Array {
    const r = new Uint8Array(N), g = new Uint8Array(N), b = new Uint8Array(N);
    for (let i = 0; i < N; i++) { r[i] = rgba[i * 4]; g[i] = rgba[i * 4 + 1]; b[i] = rgba[i * 4 + 2]; }
    return mapToPalette(r, g, b);
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
      if (this.qualityCheckCounter >= this.CHECK_FRAMES) { this.adaptQuality(); this.qualityCheckCounter = 0; this.recentSends = 0; this.recentDrops = 0; }
      return;
    }

    this.recentSends++;
    const sendStart = performance.now();

    try {
      this.dataConn.send(buf);
      const latency = performance.now() - sendStart;
      this.recentLatencies.push(latency);
      if (this.recentLatencies.length > 20) this.recentLatencies.shift();

      this.prevSentIndices   = charIndices ? new Uint8Array(charIndices) : null;
      this.prevSentColorIdx  = colorIndices ? new Uint8Array(colorIndices) : null;
    } catch {
      this.recentDrops++;
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
    const avgLatency = this.recentLatencies.length > 0
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
      : 0;
    return {
      quality: this.qualityLevel,
      fps: this.targetFps,
      keyframeInterval: this.keyframeInterval,
      latency: Math.round(avgLatency),
      drops: this.recentDrops,
    };
  }

  get isConnected() { return !!this.dataConn?.open; }
}
