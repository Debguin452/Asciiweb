import { useCallback, useEffect, useRef, useState } from "react";
import {
  renderToString, resetTemporalSmoothing, sortCharsetByDensity,
  getPoolCharIdx, getPoolColors, getPoolDims,
  type AsciiOptions,
} from "../lib/ascii";
import { CallManager, type CallStatus, type RemoteFrame } from "../lib/call";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(k: K, v: AsciiOptions[K]) => void;
}

type Screen = "home" | "starting" | "in-call";
type Facing = "user" | "environment";

// Colour-run-batched remote frame renderer
function paintRemote(frame: RemoteFrame, pre: HTMLPreElement) {
  const { w, h, charset, charIndices, colors } = frame;
  const lines: string[] = [];
  if (colors) {
    for (let y = 0; y < h; y++) {
      const parts: string[] = [];
      let rr = -1, rg = -1, rb = -1, rt = "";
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const ch = charset[charIndices[i]] ?? " ";
        const d = ch === " " ? "\u00a0" : ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
        const cr = colors[i*3], cg = colors[i*3+1], cb = colors[i*3+2];
        if (cr === rr && cg === rg && cb === rb) { rt += d; }
        else {
          if (rt) parts.push(`<span style="color:rgb(${rr},${rg},${rb})">${rt}</span>`);
          rr = cr; rg = cg; rb = cb; rt = d;
        }
      }
      if (rt) parts.push(`<span style="color:rgb(${rr},${rg},${rb})">${rt}</span>`);
      lines.push(parts.join(""));
    }
    pre.innerHTML = lines.join("\n");
  } else {
    for (let y = 0; y < h; y++) {
      let line = "";
      for (let x = 0; x < w; x++) {
        const ch = charset[charIndices[y * w + x]] ?? " ";
        line += ch === " " ? "\u00a0" : ch;
      }
      lines.push(line);
    }
    pre.textContent = lines.join("\n");
  }
}

const CALL_OPTS: Partial<AsciiOptions> = {
  asciiW: 60, asciiH: 34, brightness: 0, contrast: 100,
  gamma: 1.0, temporalSmoothing: true, color: false,
  noiseReduction: false, localContrast: false, histEq: false,
};

async function apiCreate(peerId: string): Promise<string | null> {
  try {
    const r = await fetch("/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId }),
    });
    return r.ok ? ((await r.json()) as { code?: string }).code ?? null : null;
  } catch { return null; }
}

async function apiJoin(code: string, peerId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/rooms/${code}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId }),
    });
    if (!r.ok) return null;
    const d = await r.json() as { peers?: string[] };
    return (d.peers ?? []).find(p => p !== peerId) ?? null;
  } catch { return null; }
}

async function apiLeave(code: string, peerId: string) {
  try {
    await fetch(`/api/rooms/${code}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId }),
    });
  } catch { /* ignore */ }
}

export default function CallTab({ opts, updateOpt }: Props) {
  const videoRef       = useRef<HTMLVideoElement>(null);
  const audioRef       = useRef<HTMLAudioElement>(null);
  const offscreen      = useRef(document.createElement("canvas"));
  const localPreRef    = useRef<HTMLPreElement>(null);
  const remotePreRef   = useRef<HTMLPreElement>(null);
  const localAreaRef   = useRef<HTMLDivElement>(null);
  const rafRef         = useRef(0);
  const streamRef      = useRef<MediaStream | null>(null);
  const callRef        = useRef<CallManager | null>(null);
  const optsRef        = useRef(opts);
  const fitRef         = useRef({ cols: 60, rows: 34 });
  const fsRef          = useRef(10);
  const myIdRef        = useRef("");
  const roomRef        = useRef("");

  const [screen,       setScreen]       = useState<Screen>("home");
  const [callStatus,   setCallStatus]   = useState<CallStatus>("idle");
  const [myCode,       setMyCode]       = useState("");
  const [joinVal,      setJoinVal]      = useState("");
  const [camErr,       setCamErr]       = useState<string | null>(null);
  const [connectErr,   setConnectErr]   = useState<string | null>(null);
  const [muted,        setMuted]        = useState(false);
  const [camOff,       setCamOff]       = useState(false);
  const [facing,       setFacing]       = useState<Facing>("user");
  const [colorMode,    setColorMode]    = useState(false);
  const [remoteHere,   setRemoteHere]   = useState(false);
  const [fps,          setFps]          = useState(0);
  const [copied,       setCopied]       = useState(false);
  const [joining,      setJoining]      = useState(false);
  const [starting,     setStarting]     = useState(false);

  const fpsT = useRef<number[]>([]);

  useEffect(() => { optsRef.current = opts; }, [opts]);

  // Apply call-specific option overrides once
  useEffect(() => {
    Object.entries(CALL_OPTS).forEach(([k, v]) => updateOpt(k as keyof AsciiOptions, v as never));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track container size for auto-fit columns
  useEffect(() => {
    const el = localAreaRef.current; if (!el) return;
    const obs = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      const fs = fsRef.current;
      if (width && height) fitRef.current = {
        cols: Math.max(10, Math.floor(width  / (fs * 0.575))),
        rows: Math.max(5,  Math.floor(height / (fs * 1.15))),
      };
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Call manager ─────────────────────────────────────────────────────────
  const initMgr = useCallback(() => {
    const mgr = new CallManager({
      onStatus: (s, detail) => {
        setCallStatus(s);
        if (s === "error") setConnectErr(detail ?? "Connection failed");
        if (s === "connected") { setConnectErr(null); setScreen("in-call"); }
      },
      onRemoteFrame: (f: RemoteFrame) => {
        setRemoteHere(true);
        if (remotePreRef.current) paintRemote(f, remotePreRef.current);
      },
      onRemoteHangup: () => { setRemoteHere(false); setCallStatus("closed"); },
      onRemoteStream: (s: MediaStream) => {
        if (audioRef.current) { audioRef.current.srcObject = s; audioRef.current.play().catch(() => {}); }
      },
    });
    callRef.current = mgr;
    mgr.start().then(id => { myIdRef.current = id; }).catch(() => {});
  }, []);

  useEffect(() => { initMgr(); return () => callRef.current?.hangup(); }, [initMgr]);

  // ── Render loop: single pass, pool-read for send ──────────────────────────
  const renderLoop = useCallback(() => {
    const video = videoRef.current, pre = localPreRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderLoop); return;
    }
    if (camOff) { rafRef.current = requestAnimationFrame(renderLoop); return; }

    const o = optsRef.current;
    const result = renderToString(video, offscreen.current, {
      ...o, ...CALL_OPTS, asciiW: fitRef.current.cols, asciiH: fitRef.current.rows,
      color: colorMode,
    }, facing === "user", "html");

    if (result) {
      const { html, isColor } = result;
      if (isColor) pre.innerHTML = html; else pre.textContent = html;

      if (callRef.current?.isConnected) {
        const { w, h } = getPoolDims();
        if (w > 0 && h > 0) {
          const N = w * h;
          const raw = getPoolCharIdx();
          const indices = raw.length === N ? raw : raw.slice(0, N);
          let colors: Uint8Array | null = null;
          if (colorMode) {
            const c = getPoolColors();
            colors = new Uint8Array(N * 3);
            for (let i = 0; i < N; i++) { colors[i*3]=c.r[i]; colors[i*3+1]=c.g[i]; colors[i*3+2]=c.b[i]; }
          }
          callRef.current.sendFrame(
            indices, w, h,
            sortCharsetByDensity(o.charset || " .:-=+*#%@"),
            colors
          );
        }
      }
      const now = performance.now();
      fpsT.current.push(now);
      if (fpsT.current.length > 30) fpsT.current.shift();
      if (fpsT.current.length > 1)
        setFps(Math.round((fpsT.current.length-1) / ((now - fpsT.current[0]) / 1000)));
    }
    rafRef.current = requestAnimationFrame(renderLoop);
  }, [facing, colorMode]);

  useEffect(() => {
    if (screen !== "home") rafRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [screen, renderLoop]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  // ── Camera ────────────────────────────────────────────────────────────────
  const startCam = async (face: Facing = facing) => {
    setCamErr(null);
    streamRef.current?.getTracks().forEach(t => t.stop());
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play(); }
      callRef.current?.answerWithStream(s);
      setCamOff(false);
    } catch (e) { setCamErr(e instanceof Error ? e.message : "Camera denied"); }
  };

  const flipCam = () => {
    const next: Facing = facing === "user" ? "environment" : "user";
    setFacing(next); startCam(next);
  };

  const toggleMic = () => {
    const t = streamRef.current?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; setMuted(!t.enabled);
  };

  const toggleCam = () => {
    const t = streamRef.current?.getVideoTracks()[0]; if (!t) return;
    t.enabled = camOff; setCamOff(!camOff);
    if (localPreRef.current && !camOff) localPreRef.current.textContent = "";
  };

  // ── "Start a call" ────────────────────────────────────────────────────────
  const startCall = async () => {
    setStarting(true); setCamErr(null); setConnectErr(null);
    await startCam();
    if (!myIdRef.current) {
      // PeerJS not ready yet — wait briefly
      await new Promise(r => setTimeout(r, 1500));
    }
    const code = await apiCreate(myIdRef.current) ?? myIdRef.current.slice(0, 8).toUpperCase();
    roomRef.current = code;
    setMyCode(code);
    setScreen("starting");
    setStarting(false);
  };

  // ── "Join a call" ─────────────────────────────────────────────────────────
  const joinCall = async () => {
    const code = joinVal.trim().toUpperCase();
    if (!code) return;
    setJoining(true); setConnectErr(null);
    if (screen === "home") {
      await startCam();
      setScreen("starting");
    }
    const hostId = await apiJoin(code, myIdRef.current);
    if (hostId) {
      callRef.current?.connectTo(hostId, streamRef.current);
    } else {
      // Fallback: treat code directly as peer ID
      callRef.current?.connectTo(code, streamRef.current);
    }
    roomRef.current = code;
    setJoining(false);
  };

  // ── End call ──────────────────────────────────────────────────────────────
  const endCall = () => {
    if (roomRef.current && myIdRef.current) apiLeave(roomRef.current, myIdRef.current).catch(() => {});
    callRef.current?.hangup();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (localPreRef.current)  localPreRef.current.textContent = "";
    if (remotePreRef.current) remotePreRef.current.textContent = "";
    setScreen("home"); setCallStatus("idle"); setRemoteHere(false);
    setMyCode(""); setJoinVal(""); setFps(0); fpsT.current = [];
    resetTemporalSmoothing();
    setTimeout(initMgr, 300);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(myCode).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const connected = callStatus === "connected";

  // ── HOME SCREEN ───────────────────────────────────────────────────────────
  if (screen === "home") {
    return (
      <div className="call-home">
        <div className="call-home-inner">
          <div className="call-home-hero">
            <div className="call-home-logo">{ }ASCII</div>
            <div className="call-home-logo-sub">Video Call</div>
            <p className="call-home-desc">Face-to-face in ASCII art. No account. No download.</p>
          </div>

          <div className="call-home-actions">
            <button className="call-big-btn call-big-primary" onClick={startCall} disabled={starting}>
              {starting ? <><span className="call-btn-spinner" />Starting…</> : <><span className="call-btn-icon">📡</span>Start a call</>}
            </button>
            <div className="call-home-or">or</div>
            <div className="call-join-area">
              <input
                className="call-code-input"
                placeholder="Enter code (e.g. ABCD12)"
                value={joinVal}
                onChange={e => setJoinVal(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={e => e.key === "Enter" && joinVal.length > 3 && joinCall()}
                maxLength={16}
                spellCheck={false}
                autoCapitalize="characters"
              />
              <button
                className="call-big-btn call-big-secondary"
                onClick={joinCall}
                disabled={joinVal.length < 4 || joining}
              >
                {joining ? <><span className="call-btn-spinner" />Joining…</> : <><span className="call-btn-icon">🔗</span>Join</>}
              </button>
            </div>
          </div>

          {camErr && <p className="call-home-err">⚠ {camErr}</p>}
          {connectErr && <p className="call-home-err">⚠ {connectErr}</p>}
        </div>
      </div>
    );
  }

  // ── STARTING / WAITING SCREEN ─────────────────────────────────────────────
  if (screen === "starting") {
    return (
      <div className="call-waiting-screen">
        <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
        <video ref={videoRef} playsInline muted style={{ position: "fixed", top: "-9999px", left: "-9999px", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" }} />

        <div className="call-wait-top" ref={localAreaRef}>
          <pre ref={localPreRef} className="ascii-output call-pre-fill" style={{ fontSize: "8px", lineHeight: "1.1" }} />
          {camErr && <div className="call-cam-err">⚠ {camErr}</div>}
        </div>

        <div className="call-wait-bottom">
          <div className="call-wait-section">
            <p className="call-wait-label">Your call code</p>
            <div className="call-code-display">
              {myCode.split("").map((ch, i) => (
                <span key={i} className="call-code-char">{ch}</span>
              ))}
            </div>
            <button className="call-copy-btn" onClick={copyCode}>
              {copied ? "✓ Copied!" : "Copy code"}
            </button>
            <p className="call-wait-hint">Share this code with the person you want to call</p>
          </div>

          <div className="call-wait-divider">or</div>

          <div className="call-wait-section">
            <p className="call-wait-label">Have their code?</p>
            <div className="call-join-inline">
              <input
                className="call-code-input"
                placeholder="Enter code"
                value={joinVal}
                onChange={e => setJoinVal(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={e => e.key === "Enter" && joinVal.length > 3 && joinCall()}
                maxLength={16}
                autoCapitalize="characters"
                spellCheck={false}
              />
              <button
                className="call-big-btn call-big-secondary call-big-sm"
                onClick={joinCall}
                disabled={joinVal.length < 4 || joining}
              >
                {joining ? "…" : "Connect"}
              </button>
            </div>
          </div>

          {callStatus === "connecting" && (
            <p className="call-connecting-msg"><span className="call-btn-spinner" />Connecting…</p>
          )}
          {connectErr && <p className="call-home-err">⚠ {connectErr}</p>}

          <button className="call-cancel-btn" onClick={endCall}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── IN-CALL SCREEN ────────────────────────────────────────────────────────
  return (
    <div className="call-active">
      <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
      <video ref={videoRef} playsInline muted style={{ position: "fixed", top: "-9999px", left: "-9999px", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" }} />

      {/* Two video panels */}
      <div className="call-panels">
        <div className="call-panel call-panel-remote">
          <span className="call-panel-tag">Peer</span>
          {!remoteHere && (
            <div className="call-panel-waiting">
              <div className="call-panel-waiting-icon">◌</div>
              <p>Waiting for peer video…</p>
            </div>
          )}
          <pre
            ref={remotePreRef}
            className="ascii-output call-pre-fill"
            style={{ fontSize: "8px", lineHeight: "1.1", display: remoteHere ? undefined : "none" }}
          />
        </div>

        <div ref={localAreaRef} className="call-panel call-panel-local">
          <span className="call-panel-tag">
            You {fps > 0 && <span className="call-fps-tag">{fps}fps</span>}
          </span>
          <pre ref={localPreRef} className="ascii-output call-pre-fill" style={{ fontSize: "8px", lineHeight: "1.1" }} />
        </div>
      </div>

      {/* Controls — 5 equal circular buttons, centered */}
      <div className="call-bar">
        <button
          className={`call-circle-btn${muted ? " call-circle-danger" : ""}`}
          onClick={toggleMic}
          title={muted ? "Unmute" : "Mute"}
        >
          <span className="call-circle-icon">{muted ? "🔇" : "🎤"}</span>
          <span className="call-circle-label">{muted ? "Unmuted" : "Mic"}</span>
        </button>

        <button
          className={`call-circle-btn${camOff ? " call-circle-danger" : ""}`}
          onClick={toggleCam}
          title={camOff ? "Camera off" : "Camera on"}
        >
          <span className="call-circle-icon">{camOff ? "🚫" : "📷"}</span>
          <span className="call-circle-label">{camOff ? "Off" : "Camera"}</span>
        </button>

        <button
          className={`call-circle-btn${colorMode ? " call-circle-active" : ""}`}
          onClick={() => setColorMode(m => !m)}
          title="Toggle color"
        >
          <span className="call-circle-icon">🎨</span>
          <span className="call-circle-label">Color</span>
        </button>

        <button className="call-circle-btn" onClick={flipCam} title="Flip camera">
          <span className="call-circle-icon">⟲</span>
          <span className="call-circle-label">Flip</span>
        </button>

        <button className="call-circle-btn call-circle-end" onClick={endCall} title="End call">
          <span className="call-circle-icon">✕</span>
          <span className="call-circle-label">End</span>
        </button>
      </div>
    </div>
  );
}
