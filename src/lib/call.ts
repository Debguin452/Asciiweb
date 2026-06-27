import { encode, decode, toArrayBuffer, type RemoteFrame } from "./binary";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type CallQualityLevel = "low" | "medium" | "high" | "ultra";

export interface CallQualityStep {
  keyframeInterval: number;
  targetFps: number;
  maxFrameSize: number;
}

const QUALITY_STEPS: Record<CallQualityLevel, CallQualityStep> = {
  low:    { keyframeInterval: 60, targetFps: 10, maxFrameSize: 8000  },
  medium: { keyframeInterval: 40, targetFps: 20, maxFrameSize: 16000 },
  high:   { keyframeInterval: 30, targetFps: 30, maxFrameSize: 32000 },
  ultra:  { keyframeInterval: 20, targetFps: 45, maxFrameSize: 64000 },
};

const QUALITY_ORDER: CallQualityLevel[] = ["low", "medium", "high", "ultra"];

export interface CallManagerEvents {
  onStatus: (status: CallStatus, detail?: string) => void;
  onRemoteFrame: (frame: RemoteFrame) => void;
  onRemoteHangup: () => void;
  onRemoteStream: (stream: MediaStream) => void;
  onRemoteState?: (state: RemoteState) => void;
  onQualityChange?: (level: CallQualityLevel, step: CallQualityStep) => void;
}

export type CallStatus = "idle" | "waiting" | "connecting" | "connected" | "closed" | "error";

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

  private prevSentIndices: Uint8Array | null = null;
  private prevSentColors: Uint8Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private frameCount = 0;
  private keyframeInterval = 30;
  private lastSentAt = 0;
  private targetFps = 30;

  private receivedKeyframe = false;

  private qualityLevel: CallQualityLevel = "high";
  private recentSends = 0;
  private recentDrops = 0;
  private recentLatencies: number[] = [];
  private qualityCheckCounter = 0;
  private consecutiveGood = 0;
  private consecutiveBad = 0;
  private readonly CHECK_FRAMES = 30;

  constructor(events: CallManagerEvents) {
    this.events = events;
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ config: { iceServers: ICE_SERVERS }, debug: 1 });
      this.peer = peer;

      const timeout = setTimeout(() => reject(new Error("Signaling timeout")), 10000);

      peer.on("open", id => {
        clearTimeout(timeout);
        this.events.onStatus("waiting", id);
        resolve(id);
      });

      peer.on("connection", conn => this.attachData(conn));

      peer.on("call", call => {
        this.mediaConn = call;
        if (this.localStream) {
          call.answer(this.localStream);
          call.on("stream", s => this.events.onRemoteStream(s));
          call.on("close", () => this.events.onRemoteHangup());
        } else {
          this.pendingIncomingCall = call;
        }
      });

      peer.on("error", err => {
        clearTimeout(timeout);
        this.events.onStatus("error", err.message);
        reject(err);
      });
    });
  }

  answerWithStream(stream: MediaStream) {
    this.localStream = stream;
    if (this.pendingIncomingCall) {
      const call = this.pendingIncomingCall;
      this.pendingIncomingCall = null;
      call.answer(stream);
      call.on("stream", s => this.events.onRemoteStream(s));
      call.on("close", () => this.events.onRemoteHangup());
    }
  }

  connectTo(remoteId: string, stream: MediaStream | null) {
    if (!this.peer) return;
    this.events.onStatus("connecting", remoteId);
    this.localStream = stream;

    const conn = this.peer.connect(remoteId.trim(), { reliable: true, serialization: "binary" });
    this.attachData(conn);

    if (stream) {
      const call = this.peer.call(remoteId.trim(), stream);
      this.mediaConn = call;
      call.on("stream", s => this.events.onRemoteStream(s));
      call.on("close", () => this.events.onRemoteHangup());
    }
  }

  private adaptQuality() {
    const dropRate   = this.recentSends > 0 ? this.recentDrops / this.recentSends : 0;
    const avgLatency = this.recentLatencies.length > 0
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
      : 0;

    const idx = QUALITY_ORDER.indexOf(this.qualityLevel);
    if (idx === -1) return;

    if ((dropRate > 0.3 || avgLatency > 200) && idx > 0) {
      this.consecutiveBad++;
      if (this.consecutiveBad >= 2) {
        const next = QUALITY_ORDER[idx - 1];
        this.qualityLevel = next;
        this.keyframeInterval = QUALITY_STEPS[next].keyframeInterval;
        this.targetFps        = QUALITY_STEPS[next].targetFps;
        this.consecutiveBad   = 0;
        this.events.onQualityChange?.(next, QUALITY_STEPS[next]);
      }
    } else if (dropRate < 0.05 && avgLatency < 100) {
      this.consecutiveGood++;
      if (this.consecutiveGood >= 3 && idx < QUALITY_ORDER.length - 1) {
        this.consecutiveGood = 0;
        const next = QUALITY_ORDER[idx + 1];
        this.qualityLevel = next;
        this.keyframeInterval = QUALITY_STEPS[next].keyframeInterval;
        this.targetFps        = QUALITY_STEPS[next].targetFps;
        this.events.onQualityChange?.(next, QUALITY_STEPS[next]);
      }
    }
  }

  private attachData(conn: DataConnection) {
    this.dataConn = conn;

    conn.on("open", () => {
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

    conn.on("close", () => this.events.onStatus("closed"));
    conn.on("error", err => this.events.onStatus("error", err.message));
  }

  sendFrame(
    charIndices: Uint8Array,
    w: number, h: number,
    charset: string,
    colors: Uint8Array | null
  ) {
    if (!this.dataConn?.open) return;

    const now = performance.now();
    const minInterval = 1000 / this.targetFps;
    if (this.lastSentAt > 0 && now - this.lastSentAt < minInterval) return;
    this.lastSentAt = now;

    this.frameCount++;
    const isKey = this.frameCount === 1 || this.frameCount % this.keyframeInterval === 1;

    let prev: Uint8Array | null = null;
    let prevColors: Uint8Array | null = null;
    if (!isKey && this.prevSentIndices && this.prevSentIndices.length === charIndices.length) {
      prev       = this.prevSentIndices;
      prevColors = this.prevSentColors;
    }

    const buf = encode(charIndices, w, h, charset, colors, prev, prevColors);

    this.recentSends++;
    const sendStart = performance.now();

    try {
      this.dataConn.send(buf);
      const latency = performance.now() - sendStart;
      this.recentLatencies.push(latency);
      if (this.recentLatencies.length > 20) this.recentLatencies.shift();

      this.prevSentIndices = new Uint8Array(charIndices);
      this.prevSentColors  = colors ? new Uint8Array(colors) : null;
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
    try { this.dataConn?.close(); }  catch { /* noop */ }
    try { this.mediaConn?.close(); } catch { /* noop */ }
    try { this.peer?.destroy(); }    catch { /* noop */ }
    this.dataConn  = null;
    this.mediaConn = null;
    this.peer      = null;
  }

  setTargetFps(fps: number) { this.targetFps = Math.max(5, Math.min(60, fps)); }
  getQualityLevel(): CallQualityLevel { return this.qualityLevel; }

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
