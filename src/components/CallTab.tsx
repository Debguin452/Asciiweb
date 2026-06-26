import { useCallback, useEffect, useRef, useState } from "react";
import {
  renderToString, resetTemporalSmoothing, sortCharsetByDensity,
  getPoolCharIdx, getPoolDims,
  type AsciiOptions,
} from "../lib/ascii";
import { CallManager, type CallStatus, type RemoteFrame, type RemoteState } from "../lib/call";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(k: K, v: AsciiOptions[K]) => void;
}

type Screen = "home" | "starting" | "in-call";
type Facing = "user" | "environment";
type Mode   = "host" | "guest" | null;

const BLOCK = "\u2588";

function paintRemote(frame: RemoteFrame, pre: HTMLPreElement) {
  const { w, h, charset, charIndices, colors } = frame;
  const lines: string[] = [];
  if (colors) {
    for (let y = 0; y < h; y++) {
      const parts: string[] = [];
      let rr = -1, rg = -1, rb = -1, rt = "";
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const cr = colors[i*3], cg = colors[i*3+1], cb = colors[i*3+2];
        if (cr === rr && cg === rg && cb === rb) { rt += BLOCK; }
        else {
          if (rt) parts.push(`<span style="color:rgb(${rr},${rg},${rb})">${rt}</span>`);
          rr = cr; rg = cg; rb = cb; rt = BLOCK;
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

function sampleColorFrame(
  video: HTMLVideoElement, canvas: HTMLCanvasElement,
  cols: number, rows: number, mirror: boolean
): { html: string; colors: Uint8Array; w: number; h: number } | null {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const iw = Math.min(cols, 120), ih = Math.min(rows, 68);
  if (canvas.width !== iw) canvas.width = iw;
  if (canvas.height !== ih) canvas.height = ih;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.save();
  if (mirror) { ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, vw, vh, -iw, 0, iw, ih); }
  else ctx.drawImage(video, 0, 0, vw, vh, 0, 0, iw, ih);
  ctx.restore();
  const px = ctx.getImageData(0, 0, iw, ih).data;
  const N = iw * ih;
  const colors = new Uint8Array(N * 3);
  const lines: string[] = new Array(ih);
  for (let y = 0; y < ih; y++) {
    const parts: string[] = [];
    let rr = -1, rg = -1, rb = -1, rt = "";
    for (let x = 0; x < iw; x++) {
      const o4 = (y * iw + x) * 4;
      const cr = px[o4], cg = px[o4+1], cb = px[o4+2];
      const ci = y * iw + x;
      colors[ci*3] = cr; colors[ci*3+1] = cg; colors[ci*3+2] = cb;
      if (cr === rr && cg === rg && cb === rb) { rt += BLOCK; }
      else {
        if (rt) parts.push(`<span style="color:rgb(${rr},${rg},${rb})">${rt}</span>`);
        rr = cr; rg = cg; rb = cb; rt = BLOCK;
      }
    }
    if (rt) parts.push(`<span style="color:rgb(${rr},${rg},${rb})">${rt}</span>`);
    lines[y] = parts.join("");
  }
  return { html: lines.join("\n"), colors, w: iw, h: ih };
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
  } catch { /**/ }
}

function apiLeaveBeacon(code: string, peerId: string) {
  if (!code || !peerId) return;
  const blob = new Blob([JSON.stringify({ peerId })], { type: "application/json" });
  const sent = navigator.sendBeacon ? navigator.sendBeacon(`/api/rooms/${code}`, blob) : false;
  if (!sent) {
    fetch(`/api/rooms/${code}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId }),
      keepalive: true,
    }).catch(() => {});
  }
}

const SvgMicOn  = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>;
const SvgMicOff = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>;
const SvgCamOn  = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>;
const SvgCamOff = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34"/><path d="M15.54 15.54A3 3 0 0 1 9 12a3 3 0 0 1 .46-1.54"/></svg>;

export default function CallTab({ opts, updateOpt }: Props) {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const audioRef      = useRef<HTMLAudioElement>(null);
  const offscreen     = useRef(document.createElement("canvas"));
  const colorCanvas   = useRef(document.createElement("canvas"));
  const localPreRef   = useRef<HTMLPreElement>(null);
  const remotePreRef  = useRef<HTMLPreElement>(null);
  const localAreaRef  = useRef<HTMLDivElement>(null);
  const remoteAreaRef = useRef<HTMLDivElement>(null);
  const callScreenRef = useRef<HTMLDivElement>(null);
  const callFsRef     = useRef(6);
  const rafRef        = useRef(0);
  const streamRef     = useRef<MediaStream | null>(null);
  const callRef       = useRef<CallManager | null>(null);
  const optsRef       = useRef(opts);
  const fitRef        = useRef({ cols: 60, rows: 34 });
  const myIdRef       = useRef("");
  const roomRef       = useRef("");
  const modeRef       = useRef<Mode>(null);
  const mutedRef      = useRef(false);
  const camOffRef     = useRef(false);
  const colorModeRef  = useRef(false);
  const facingRef     = useRef<Facing>("user");
  const fpsT          = useRef<number[]>([]);

  const [screen,        setScreen]        = useState<Screen>("home");
  const [callStatus,    setCallStatus]    = useState<CallStatus>("idle");
  const [mode,          setMode]          = useState<Mode>(null);
  const [myCode,        setMyCode]        = useState("");
  const [joinVal,       setJoinVal]       = useState("");
  const [camErr,        setCamErr]        = useState<string | null>(null);
  const [connectErr,    setConnectErr]    = useState<string | null>(null);
  const [muted,         setMuted]         = useState(false);
  const [camOff,        setCamOff]        = useState(false);
  const [facing,        setFacing]        = useState<Facing>("user");
  const [colorMode,     setColorMode]     = useState(false);
  const [remoteHere,    setRemoteHere]    = useState(false);
  const [peerHungUp,    setPeerHungUp]    = useState(false);
  const [remoteMuted,   setRemoteMuted]   = useState(false);
  const [remoteCamOff,  setRemoteCamOff]  = useState(false);
  const [fps,           setFps]           = useState(0);
  const [copied,        setCopied]        = useState(false);
  const [joining,       setJoining]       = useState(false);
  const [starting,      setStarting]      = useState(false);
  const [fullscreen,    setFullscreen]    = useState(false);
  const [expandedPanel, setExpandedPanel] = useState<"local"|"remote"|null>(null);
  const [showSettings, setShowSettings]   = useState(false);
  const [pipPos,       setPipPos]         = useState({ right: 12, bottom: 68 });
  const pipDragRef = useRef<{ startX: number; startY: number; origRight: number; origBottom: number } | null>(null);

  useEffect(() => { optsRef.current = opts; }, [opts]);
  useEffect(() => { colorModeRef.current = colorMode; }, [colorMode]);
  useEffect(() => { facingRef.current = facing; }, [facing]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { camOffRef.current = camOff; }, [camOff]);

  useEffect(() => {
    Object.entries(CALL_OPTS).forEach(([k, v]) => updateOpt(k as keyof AsciiOptions, v as never));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // WhatsApp layout:
  //   Remote (main panel) → fills full call area, font auto-fits to opts.asciiW × opts.asciiH grid
  //   Local (PiP corner)  → fixed small grid, font auto-fits to PiP box size
  const remoteFitRef = useRef({ cols: 60, rows: 34 });

  const updateCallFontSize = useCallback(() => {
    const o = optsRef.current;
    const remCols = Math.max(10, o.asciiW || 60);
    const remRows = Math.max(5,  o.asciiH || 34);

    // Main (remote) panel — font computed so remCols×remRows fills the panel
    const remEl = remoteAreaRef.current;
    if (remEl) {
      const { width, height } = remEl.getBoundingClientRect();
      if (width && height) {
        const fsByW = width  / (remCols * 0.575);
        const fsByH = height / (remRows * 1.1);
        const fs = Math.max(2, Math.floor(Math.min(fsByW, fsByH)));
        remoteFitRef.current = { cols: remCols, rows: remRows };
        if (remotePreRef.current) {
          remotePreRef.current.style.fontSize   = fs + "px";
          remotePreRef.current.style.lineHeight = "1.1";
        }
      }
    }

    // PiP (local) panel — fixed 28×16 grid, font fills the pip box
    const PIP_COLS = 28, PIP_ROWS = 16;
    const locEl = localAreaRef.current;
    if (locEl) {
      const { width, height } = locEl.getBoundingClientRect();
      if (width && height) {
        const fsByW = width  / (PIP_COLS * 0.575);
        const fsByH = height / (PIP_ROWS * 1.1);
        const fs = Math.max(2, Math.floor(Math.min(fsByW, fsByH)));
        callFsRef.current = fs;
        fitRef.current = { cols: PIP_COLS, rows: PIP_ROWS };
        if (localPreRef.current) {
          localPreRef.current.style.fontSize   = fs + "px";
          localPreRef.current.style.lineHeight = "1.1";
        }
      }
    }
  }, []);

  useEffect(() => {
    const obs = new ResizeObserver(updateCallFontSize);
    if (localAreaRef.current)  obs.observe(localAreaRef.current);
    if (remoteAreaRef.current) obs.observe(remoteAreaRef.current);
    updateCallFontSize();
    return () => obs.disconnect();
  }, [updateCallFontSize]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    const el = callScreenRef.current;
    if (!document.fullscreenElement && el) el.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
    const onLeave = () => {
      if (roomRef.current && myIdRef.current) apiLeaveBeacon(roomRef.current, myIdRef.current);
    };
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, []);

  const initMgr = useCallback(() => {
    const mgr = new CallManager({
      onStatus: (s, detail) => {
        setCallStatus(s);
        if (s === "error") setConnectErr(detail ?? "Connection failed");
        if (s === "connected") { setConnectErr(null); setScreen("in-call"); }
      },
      onRemoteFrame: (f: RemoteFrame) => {
        setRemoteHere(true);
        setPeerHungUp(false);
        if (remotePreRef.current) paintRemote(f, remotePreRef.current);
      },
      onRemoteHangup: () => {
        setRemoteHere(false);
        setPeerHungUp(true);
        setCallStatus("closed");
      },
      onRemoteStream: (s: MediaStream) => {
        if (audioRef.current) { audioRef.current.srcObject = s; audioRef.current.play().catch(() => {}); }
      },
      onRemoteState: (state: RemoteState) => {
        setRemoteMuted(state.micMuted);
        setRemoteCamOff(state.camOff);
      },
    });
    callRef.current = mgr;
    mgr.start().then(id => { myIdRef.current = id; }).catch(() => {});
  }, []);

  useEffect(() => { initMgr(); return () => callRef.current?.hangup(); }, [initMgr]);

  const renderLoop = useCallback(() => {
    const video = videoRef.current, pre = localPreRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderLoop); return;
    }
    if (camOffRef.current) { rafRef.current = requestAnimationFrame(renderLoop); return; }

    const isColor  = colorModeRef.current;
    const isMirror = facingRef.current === "user";

    const pip = fitRef.current;

    if (isColor) {
      const result = sampleColorFrame(video, colorCanvas.current, pip.cols, pip.rows, isMirror);
      if (result) {
        // innerHTML with newlines works fine on <pre> without display:flex
        pre.innerHTML = result.html;
        if (callRef.current?.isConnected) {
          const dummy = new Uint16Array(result.w * result.h);
          callRef.current.sendFrame(dummy, result.w, result.h, BLOCK, result.colors);
        }
        const now = performance.now();
        fpsT.current.push(now);
        if (fpsT.current.length > 30) fpsT.current.shift();
        if (fpsT.current.length > 1) setFps(Math.round((fpsT.current.length-1) / ((now - fpsT.current[0]) / 1000)));
      }
    } else {
      const o = optsRef.current;
      const result = renderToString(video, offscreen.current, {
        ...o, ...CALL_OPTS, asciiW: pip.cols, asciiH: pip.rows, color: false,
      }, isMirror, "html");
      if (result) {
        pre.textContent = result.html;
        if (callRef.current?.isConnected) {
          const { w, h } = getPoolDims();
          if (w > 0 && h > 0) {
            const N = w * h;
            const raw = getPoolCharIdx();
            callRef.current.sendFrame(raw.length === N ? raw : raw.slice(0, N), w, h, sortCharsetByDensity(o.charset || " .:-=+*#%@"), null);
          }
        }
        const now = performance.now();
        fpsT.current.push(now);
        if (fpsT.current.length > 30) fpsT.current.shift();
        if (fpsT.current.length > 1) setFps(Math.round((fpsT.current.length-1) / ((now - fpsT.current[0]) / 1000)));
      }
    }

    rafRef.current = requestAnimationFrame(renderLoop);
  }, []);

  useEffect(() => {
    if (screen !== "home") rafRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [screen, renderLoop]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

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
    t.enabled = !t.enabled;
    const newMuted = !t.enabled;
    setMuted(newMuted);
    callRef.current?.sendState(newMuted, camOffRef.current);
  };

  const toggleCam = () => {
    const t = streamRef.current?.getVideoTracks()[0]; if (!t) return;
    t.enabled = camOff;
    const newCamOff = !camOff;
    setCamOff(newCamOff);
    if (localPreRef.current && !camOff) localPreRef.current.textContent = "";
    callRef.current?.sendState(mutedRef.current, newCamOff);
  };

  const startCall = async () => {
    console.log('[CallTab] 🚀 Starting call...');
    setStarting(true); setCamErr(null); setConnectErr(null);
    
    try {
      await startCam();
    } catch (e) {
      setCamErr(e instanceof Error ? e.message : "Camera failed");
      setStarting(false);
      return;
    }

    // Wait for PeerJS to connect and give us an ID
    let attempts = 0;
    while (!myIdRef.current && attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    if (!myIdRef.current) {
      setConnectErr("Call system failed to connect. Check internet.");
      setStarting(false);
      return;
    }

    // Try Cloudflare API for short code, fallback to PeerJS ID locally
    let code = myIdRef.current;
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: myIdRef.current })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.code) code = data.code;
      }
    } catch (e) {
      console.warn('[CallTab] ⚠️ API unavailable, using PeerJS ID as code');
    }

    roomRef.current = code;
    modeRef.current = "host";
    setMode("host");
    setMyCode(code);
    setScreen("starting");
    setStarting(false);
  };


  const joinCall = async () => {
    const code = joinVal.trim().toUpperCase();
    if (!code) return;
    setJoining(true); setConnectErr(null);
    if (screen === "home") {
      await startCam();
      modeRef.current = "guest"; setMode("guest"); setScreen("starting");
    }
    const hostId = await apiJoin(code, myIdRef.current);
    if (hostId) callRef.current?.connectTo(hostId, streamRef.current);
    else        callRef.current?.connectTo(code,   streamRef.current);
    roomRef.current = code;
    setJoining(false);
  };

  const endCall = async () => {
    if (roomRef.current && myIdRef.current) await apiLeave(roomRef.current, myIdRef.current).catch(() => {});
    roomRef.current = ""; modeRef.current = null;
    callRef.current?.hangup();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (localPreRef.current)  localPreRef.current.textContent = "";
    if (remotePreRef.current) remotePreRef.current.textContent = "";
    setScreen("home"); setCallStatus("idle"); setRemoteHere(false);
    setPeerHungUp(false); setRemoteMuted(false); setRemoteCamOff(false);
    setMode(null); setMyCode(""); setJoinVal(""); setFps(0); fpsT.current = [];
    setMuted(false); setCamOff(false); setExpandedPanel(null);
    resetTemporalSmoothing();
    setTimeout(initMgr, 300);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(myCode).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  // Draggable PiP handlers
  const onPipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pipDragRef.current = {
      startX: e.clientX, startY: e.clientY,
      origRight: pipPos.right, origBottom: pipPos.bottom,
    };
  };
  const onPipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = pipDragRef.current; if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    const container = callScreenRef.current;
    const pip       = localAreaRef.current;
    if (!container || !pip) return;
    const cw = container.clientWidth, ch = container.clientHeight;
    const pw = pip.offsetWidth,       ph = pip.offsetHeight;
    const newRight  = Math.max(0, Math.min(cw - pw, d.origRight  - dx));
    const newBottom = Math.max(0, Math.min(ch - ph, d.origBottom - dy));
    setPipPos({ right: newRight, bottom: newBottom });
  };
  const onPipPointerUp = () => { pipDragRef.current = null; };

  if (screen === "home") {
    return (
      <div className="call-home">
        <div className="call-home-inner">
          <div className="call-home-hero">
            <div className="call-home-logo">ASCII</div>
            <div className="call-home-logo-sub">Video Call</div>
            <p className="call-home-desc">Face-to-face in ASCII art. No account. No download.</p>
          </div>
          <div className="call-home-actions">
            <button className="call-big-btn call-big-primary" onClick={startCall} disabled={starting}>
              {starting ? <><span className="call-btn-spinner" />Starting…</> : <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.46 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                Start a call
              </>}
            </button>
            <div className="call-home-or">or</div>
            <div className="call-join-area">
              <input className="call-code-input" placeholder="Enter code" value={joinVal}
                onChange={e => setJoinVal(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={e => e.key === "Enter" && joinVal.length > 3 && joinCall()}
                maxLength={16} spellCheck={false} autoCapitalize="characters" />
              <button className="call-big-btn call-big-secondary" onClick={joinCall} disabled={joinVal.length < 4 || joining}>
                {joining ? <><span className="call-btn-spinner" />Joining…</> : <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  Join
                </>}
              </button>
            </div>
          </div>
          {camErr     && <p className="call-home-err">{camErr}</p>}
          {connectErr && <p className="call-home-err">{connectErr}</p>}
        </div>
      </div>
    );
  }

  if (screen === "starting" && mode === "host") {
    return (
      <div className="call-waiting-screen">
        <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
        <video ref={videoRef} playsInline muted style={{ display: "none" }} />
        <div className="call-wait-top" ref={localAreaRef}>
          <pre ref={localPreRef} className="ascii-output call-pre-fill" style={{ lineHeight: "1.1" }} />
          {camErr && <div className="call-cam-err">{camErr}</div>}
        </div>
        <div className="call-wait-bottom">
          <p className="call-wait-label">Your call code — share it</p>
          <div className="call-code-display">
            {myCode.split("").map((ch, i) => <span key={i} className="call-code-char">{ch}</span>)}
          </div>
          <button className="call-copy-btn" onClick={copyCode}>{copied ? "Copied!" : "Copy code"}</button>
          <p className="call-wait-hint">Waiting for the other person to join…</p>
          {callStatus === "connecting" && <p className="call-connecting-msg"><span className="call-btn-spinner" />Connecting…</p>}
          {connectErr && <p className="call-home-err">{connectErr}</p>}
          <button className="call-cancel-btn" onClick={endCall}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back</button>
        </div>
      </div>
    );
  }

  if (screen === "starting" && mode === "guest") {
    return (
      <div className="call-waiting-screen">
        <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
        <video ref={videoRef} playsInline muted style={{ display: "none" }} />
        <div className="call-wait-top" ref={localAreaRef}>
          <pre ref={localPreRef} className="ascii-output call-pre-fill" style={{ lineHeight: "1.1" }} />
          {camErr && <div className="call-cam-err">{camErr}</div>}
        </div>
        <div className="call-wait-bottom">
          {callStatus === "connecting"
            ? <p className="call-connecting-msg"><span className="call-btn-spinner" />Connecting…</p>
            : <p className="call-wait-hint">Establishing connection…</p>
          }
          {connectErr && (
            <>
              <p className="call-home-err">{connectErr}</p>
              <div className="call-join-inline">
                <input className="call-code-input" placeholder="Re-enter code" value={joinVal}
                  onChange={e => setJoinVal(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  onKeyDown={e => e.key === "Enter" && joinVal.length > 3 && joinCall()}
                  maxLength={16} autoCapitalize="characters" spellCheck={false} />
                <button className="call-big-btn call-big-secondary call-big-sm" onClick={joinCall} disabled={joinVal.length < 4 || joining}>
                  {joining ? "…" : "Retry"}
                </button>
              </div>
            </>
          )}
          <button className="call-cancel-btn" onClick={endCall}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="call-active" ref={callScreenRef}>
      <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />

      {/* WhatsApp-style: remote fills all, local is PiP in corner */}
      <div className="call-panels-wa">
        {/* Remote — full background */}
        <div ref={remoteAreaRef} className="call-panel-wa-remote">
          {peerHungUp ? (
            <div className="call-peer-hung-up">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.46 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
              <p>Peer ended the call</p>
              <button className="call-cancel-btn" onClick={endCall}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back
              </button>
            </div>
          ) : !remoteHere ? (
            <div className="call-panel-waiting">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{opacity:0.35}}>
                <circle cx="12" cy="12" r="10" strokeDasharray="4 2"/>
                <circle cx="12" cy="8" r="1.5" fill="currentColor"/>
                <path d="M12 12v4"/>
              </svg>
              <p>Connecting to peer…</p>
            </div>
          ) : null}
          <pre ref={remotePreRef} className="ascii-output call-pre-wa"
            style={{ display: remoteHere && !peerHungUp ? undefined : "none" }} />
          {remoteHere && (remoteMuted || remoteCamOff) && (
            <span className="call-remote-badges">
              {remoteMuted  && <span title="Peer muted"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></span>}
              {remoteCamOff && <span title="Camera off"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34"/></svg></span>}
            </span>
          )}
        </div>

        {/* Local — draggable PiP */}
        <div
          ref={localAreaRef}
          className="call-panel-wa-local"
          style={{ right: pipPos.right, bottom: pipPos.bottom, position: "absolute" }}
          onPointerDown={onPipPointerDown}
          onPointerMove={onPipPointerMove}
          onPointerUp={onPipPointerUp}
          onPointerCancel={onPipPointerUp}
          onClick={e => { if (pipDragRef.current === null && Math.abs(e.clientX) < 5) return; }}
        >
          {fps > 0 && <span className="call-pip-fps">{fps}fps</span>}
          <pre ref={localPreRef} className="ascii-output call-pre-pip" />
        </div>

        {/* Settings panel overlay */}
        {showSettings && (
          <div className="call-settings-overlay" onClick={() => setShowSettings(false)}>
            <div className="call-settings-panel" onClick={e => e.stopPropagation()}>
              <div className="call-settings-title">Grid size</div>
              <div className="call-settings-row">
                <span>Cols</span>
                <input type="range" min="20" max="120" step="4"
                  value={opts.asciiW}
                  onChange={e => { updateOpt("asciiW", +e.target.value); setTimeout(updateCallFontSize, 50); }}
                />
                <span className="call-settings-val">{opts.asciiW}</span>
              </div>
              <div className="call-settings-row">
                <span>Rows</span>
                <input type="range" min="10" max="80" step="2"
                  value={opts.asciiH}
                  onChange={e => { updateOpt("asciiH", +e.target.value); setTimeout(updateCallFontSize, 50); }}
                />
                <span className="call-settings-val">{opts.asciiH}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="call-bar">
        <button
          className={`call-circle-btn${muted ? " call-circle-muted" : " call-circle-active-mic"}`}
          onClick={toggleMic}
          title={muted ? "Unmute mic" : "Mute mic"}
        >
          <span className="call-circle-icon" style={{ position: "relative", display: "inline-flex" }}>
            {SvgMicOn}
            {muted && (
              <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="2" y1="2" x2="22" y2="22"/></svg>
              </span>
            )}
          </span>
          <span className="call-circle-label">{muted ? "Unmute" : "Mic"}</span>
        </button>

        <button className={`call-circle-btn${camOff ? " call-circle-danger" : ""}`} onClick={toggleCam} title={camOff ? "Camera off" : "Camera on"}>
          <span className="call-circle-icon">{camOff ? SvgCamOff : SvgCamOn}</span>
          <span className="call-circle-label">{camOff ? "Off" : "Camera"}</span>
        </button>

        <button className={`call-circle-btn${colorMode ? " call-circle-active" : ""}`} onClick={() => setColorMode(m => !m)} title="Color blocks">
          <span className="call-circle-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" fill="currentColor" opacity=".8" rx="1"/>
              <rect x="14" y="3" width="7" height="7" fill="currentColor" opacity=".5" rx="1"/>
              <rect x="3" y="14" width="7" height="7" fill="currentColor" opacity=".4" rx="1"/>
              <rect x="14" y="14" width="7" height="7" fill="currentColor" opacity=".7" rx="1"/>
            </svg>
          </span>
          <span className="call-circle-label">Color</span>
        </button>

        <button className="call-circle-btn" onClick={flipCam} title="Flip camera">
          <span className="call-circle-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
            </svg>
          </span>
          <span className="call-circle-label">Flip</span>
        </button>

        <button className={`call-circle-btn${showSettings ? " call-circle-active" : ""}`} onClick={() => setShowSettings(s => !s)} title="Grid settings">
          <span className="call-circle-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </span>
          <span className="call-circle-label">Grid</span>
        </button>

        <button className="call-circle-btn" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
          <span className="call-circle-icon">
            {fullscreen
              ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
              : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            }
          </span>
          <span className="call-circle-label">{fullscreen ? "Exit" : "Full"}</span>
        </button>

        <button className="call-circle-btn call-circle-end" onClick={endCall} title="End call">
          <span className="call-circle-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.46 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/><line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          </span>
          <span className="call-circle-label">End</span>
        </button>
      </div>
    </div>
  );
}
