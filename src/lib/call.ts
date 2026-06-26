import { encode, decode, toArrayBuffer, type RemoteFrame } from "./binary";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject"
  },
];

const PEER_OPTIONS = [
  { config: { iceServers: ICE_SERVERS }, debug: 1 },
  { config: { iceServers: ICE_SERVERS }, debug: 1, pingInterval: 10000 },
];

export type CallQualityLevel = "low" | "medium" | "high" | "ultra";

export interface CallQualityStep {
  keyframeInterval: number;
  targetFps: number;
  maxFrameSize: number;
}

const QUALITY_STEPS: Record<CallQualityLevel, CallQualityStep> = {
  low:    { keyframeInterval: 60, targetFps: 10, maxFrameSize: 16000 },
  medium: { keyframeInterval: 40, targetFps: 20, maxFrameSize: 32000 },
  high:   { keyframeInterval: 30, targetFps: 30, maxFrameSize: 64000 },
  ultra:  { keyframeInterval: 20, targetFps: 45, maxFrameSize: 128000 },
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
  
  private prevSentIndices: Uint16Array | null = null;
  private prevSentColors: Uint8Array | null = null;
  private prevRecvFrame: RemoteFrame | null = null;
  private frameCount = 0;
  private keyframeInterval = 30;
  private lastSentAt = 0;
  private targetFps = 30;
  
  private receivedKeyframe = false;
  private lastKeyframeAt = 0;
  private maxDeltaWithoutKeyframe = 5000;
  
  private qualityLevel: CallQualityLevel = "high";
  private recentSends = 0;
  private recentDrops = 0;
  private recentLatencies: number[] = [];
  private qualityCheckCounter = 0;
  private consecutiveGood = 0;
  private consecutiveBad = 0;
  private readonly CHECK_FRAMES = 30;
  
  private frameBuffer: Array<{ frame: RemoteFrame; timestamp: number }> = [];
  private jitterBufferSize = 3;
  private lastRenderedFrameTime = 0;

  constructor(events: CallManagerEvents) { 
    this.events = events; 
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      let attemptIndex = 0;
      
      const tryConnect = () => {
        if (attemptIndex >= PEER_OPTIONS.length) {
          reject(new Error("All signaling servers failed"));
          return;
        }
        
        const opts = PEER_OPTIONS[attemptIndex];
        const peer = new Peer(opts);
        this.peer = peer;
        
        const timeout = setTimeout(() => {
          console.warn(`Signaling attempt ${attemptIndex + 1} timed out`);
          try { peer.destroy(); } catch {}
          attemptIndex++;
          tryConnect();
        }, 8000);

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
            call.on("error", () => this.events.onRemoteHangup());
          } else {
            this.pendingIncomingCall = call;
          }
        });

        peer.on("error", err => {
          clearTimeout(timeout);
          attemptIndex++;
          if (attemptIndex < PEER_OPTIONS.length) {
            try { peer.destroy(); } catch {}
            setTimeout(tryConnect, 500);
          } else {
            this.events.onStatus("error", err.message);
            reject(err);
          }
        });

        peer.on("disconnected", () => {
          setTimeout(() => { 
            try { 
              if (peer && !peer.destroyed) peer.reconnect(); 
            } catch {} 
          }, 2000);
        });
      };
      
      tryConnect();
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
      call.on("error", () => this.events.onRemoteHangup());
    }
  }

  connectTo(remoteId: string, stream: MediaStream | null) {
    if (!this.peer) return;
    this.events.onStatus("connecting", remoteId);
    this.localStream = stream;

    const conn = this.peer.connect(remoteId.trim(), { 
      reliable: true, 
      serialization: "binary",
      metadata: { version: 1 }
    });
    this.attachData(conn);

    if (stream) {
      const call = this.peer.call(remoteId.trim(), stream);
      this.mediaConn = call;
      call.on("stream", s => this.events.onRemoteStream(s));
      call.on("close", () => this.events.onRemoteHangup());
      call.on("error", () => this.events.onRemoteHangup());
    }
  }

  private adaptQuality() {
    const dropRate = this.recentSends > 0 ? this.recentDrops / this.recentSends : 0;
    const avgLatency = this.recentLatencies.length > 0 
      ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length 
      : 0;
    
    const idx = QUALITY_ORDER.indexOf(this.qualityLevel);
    if (idx === -1) return;

    if ((dropRate > 0.3 || avgLatency > 200) && idx > 0) {
      this.consecutiveGood = 0;
      this.consecutiveBad++;
      
      if (this.consecutiveBad >= 2) {
        const next = QUALITY_ORDER[idx - 1];
        this.qualityLevel = next;
        this.keyframeInterval = QUALITY_STEPS[next].keyframeInterval;
        this.targetFps = QUALITY_STEPS[next].targetFps;
        this.consecutiveBad = 0;
        this.events.onQualityChange?.(next, QUALITY_STEPS[next]);
      }
    } else if (dropRate < 0.05 && avgLatency < 100) {
      this.consecutiveBad = 0;
      this.consecutiveGood++;
      
      if (this.consecutiveGood >= 3 && idx < QUALITY_ORDER.length - 1) {
        this.consecutiveGood = 0;
        const next = QUALITY_ORDER[idx + 1];
        this.qualityLevel = next;
        this.keyframeInterval = QUALITY_STEPS[next].keyframeInterval;
        this.targetFps = QUALITY_STEPS[next].targetFps;
        this.events.onQualityChange?.(next, QUALITY_STEPS[next]);
      }
    } else {
      this.consecutiveGood = 0;
      this.consecutiveBad = 0;
    }
  }

  private attachData(conn: DataConnection) {
    this.dataConn = conn;
    
    conn.on("open", () => {
      this.events.onStatus("connected");
      this.receivedKeyframe = false;
      this.prevRecvFrame = null;
      this.frameBuffer = [];
    });
    
    conn.on("data", (data: unknown) => {
      if (data && typeof data === "object" && !ArrayBuffer.isView(data)
        && !(data instanceof Blob) && !(data instanceof ArrayBuffer)
        && "type" in (data as Record<string, unknown>)
        && (data as { type: string }).type === "state") {
        const st = data as { type: string; micMuted: boolean; camOff: boolean };
        this.events.onRemoteState?.({ micMuted: st.micMuted, camOff: st.camOff });
        return;
      }
      
      const buf = toArrayBuffer(data);
      if (buf) {
        const sendTime = performance.now();
        const frame = decode(buf, this.prevRecvFrame);
        
        if (frame) {
          if (frame.isKeyframe) {
            this.receivedKeyframe = true;
            this.lastKeyframeAt = sendTime;
            this.prevRecvFrame = frame;
            this.events.onRemoteFrame(frame);
            this.lastRenderedFrameTime = sendTime;
          } else if (this.receivedKeyframe) {
            if (sendTime - this.lastKeyframeAt > this.maxDeltaWithoutKeyframe) {
              console.warn("Too long without keyframe, discarding delta");
              return;
            }
            
            this.prevRecvFrame = frame;
            this.frameBuffer.push({ frame, timestamp: sendTime });
            this.flushJitterBuffer();
          }
        }
        return;
      }
      
      if (data instanceof Blob) {
        data.arrayBuffer().then(ab => {
          const frame = decode(ab, this.prevRecvFrame);
          if (frame) {
            if (frame.isKeyframe) {
              this.receivedKeyframe = true;
              this.lastKeyframeAt = performance.now();
            }
            if (frame.isKeyframe || this.receivedKeyframe) {
              this.prevRecvFrame = frame;
              this.events.onRemoteFrame(frame);
            }
          }
        }).catch(() => {});
      }
    });
    
    conn.on("close", () => this.events.onStatus("closed"));
    conn.on("error", err => this.events.onStatus("error", err.message));
  }
  
  private flushJitterBuffer() {
    if (this.frameBuffer.length < this.jitterBufferSize) return;
    
    this.frameBuffer.sort((a, b) => a.timestamp - b.timestamp);
    const toRender = this.frameBuffer.shift();
    if (toRender) {
      this.events.onRemoteFrame(toRender.frame);
      this.lastRenderedFrameTime = toRender.timestamp;
    }
  }

  sendFrame(
    charIndices: Uint16Array, w: number, h: number,
    charset: string, colors: Uint8Array | null
  ) {
    if (!this.dataConn?.open) return;
    
    const now = performance.now();
    const minInterval = 1000 / this.targetFps;
    if (this.lastSentAt > 0 && now - this.lastSentAt < minInterval) return;
    this.lastSentAt = now;
    
    this.frameCount++;
    const isKey = this.frameCount === 1 || this.frameCount % this.keyframeInterval === 1;
    
    let prev: Uint16Array | null = null;
    let prevColors: Uint8Array | null = null;
    
    if (!isKey && this.prevSentIndices && this.prevSentIndices.length === charIndices.length) {
      prev = this.prevSentIndices;
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
      
      if (isKey || !this.prevSentIndices) {
        this.prevSentIndices = new Uint16Array(charIndices);
        this.prevSentColors = colors ? new Uint8Array(colors) : null;
      } else if (this.prevSentIndices.length === charIndices.length) {
        this.prevSentIndices.set(charIndices);
        if (colors && this.prevSentColors && this.prevSentColors.length === colors.length) {
          this.prevSentColors.set(colors);
        } else if (colors) {
          this.prevSentColors = new Uint8Array(colors);
        } else {
          this.prevSentColors = null;
        }
      } else {
        this.prevSentIndices = new Uint16Array(charIndices);
        this.prevSentColors = colors ? new Uint8Array(colors) : null;
      }
    } catch (err) {
      this.recentDrops++;
      console.warn("Frame send failed:", err);
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
    try { 
      this.dataConn.send({ type: "state", micMuted, camOff }); 
    } catch {}
  }

  hangup() {
    this.frameCount = 0;
    this.prevSentIndices = null;
    this.prevSentColors = null;
    this.prevRecvFrame = null;
    this.pendingIncomingCall = null;
    this.recentSends = 0;
    this.recentDrops = 0;
    this.recentLatencies = [];
    this.qualityCheckCounter = 0;
    this.consecutiveGood = 0;
    this.consecutiveBad = 0;
    this.qualityLevel = "high";
    this.keyframeInterval = 30;
    this.targetFps = 30;
    this.receivedKeyframe = false;
    this.lastKeyframeAt = 0;
    this.frameBuffer = [];
    
    try { this.dataConn?.close(); } catch {}
    try { this.mediaConn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    
    this.dataConn = null;
    this.mediaConn = null;
    this.peer = null;
    this.localStream = null;
  }

  setTargetFps(fps: number) { 
    this.targetFps = Math.max(5, Math.min(60, fps)); 
  }
  
  getQualityLevel(): CallQualityLevel { return this.qualityLevel; }
  
  setQualityLevel(level: CallQualityLevel) {
    this.qualityLevel = level;
    this.keyframeInterval = QUALITY_STEPS[level].keyframeInterval;
    this.targetFps = QUALITY_STEPS[level].targetFps;
  }
  
  getStats(): { 
    quality: CallQualityLevel; 
    fps: number; 
    keyframeInterval: number;
    latency: number;
    drops: number;
  } {
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
