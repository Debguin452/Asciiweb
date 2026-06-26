import { useCallback, useEffect, useRef, useState } from "react";
import { processFrame, renderToString, resetTemporalSmoothing, type AsciiOptions, type AsciiFrame } from "../lib/ascii";
import { saveLibraryItem, makeThumbnail, genId } from "../lib/library";
import { exportGif, exportMp4, exportPng, exportJpeg, framesToText } from "../lib/export";
import { makeFilename, triggerDownload, getExportBg } from "../types";
import ControlsPanel from "./ControlsPanel";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
  onLibraryUpdated: () => void;
  exportFg: string;
  onExportFgChange: (v: string) => void;
}

type Stage = "idle" | "live" | "recording" | "choosing" | "exporting";
type CamQuality = "hq" | "balanced" | "hs";

const RESOLUTIONS = {
  "480p":  { width: 640,  height: 480,  label: "480p (Fast)" },
  "720p":  { width: 1280, height: 720,  label: "720p (Balanced)" },
  "1080p": { width: 1920, height: 1080, label: "1080p (Quality)" },
};

const CAM_QUALITY: Record<CamQuality, {
  label: string;
  title: string;
  video: MediaTrackConstraints;
  minFrameMs: number;
  forceSmooth: boolean;
  disableHeavy: boolean;
}> = {
  hq:       { label: "HQ",  title: "High Quality — 720p, 25fps, temporal smoothing", video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720  } }, minFrameMs: 40,  forceSmooth: true,  disableHeavy: false },
  balanced: { label: "Bal", title: "Balanced — 480p, 30fps",                         video: { facingMode: "user", width: { ideal: 640  }, height: { ideal: 480  } }, minFrameMs: 33,  forceSmooth: false, disableHeavy: false },
  hs:       { label: "HS",  title: "High Speed — 360p, max FPS, minimal processing", video: { facingMode: "user", width: { ideal: 640  }, height: { ideal: 360  } }, minFrameMs: 0,   forceSmooth: false, disableHeavy: true  },
};

export default function CameraTab({ opts, updateOpt, fontSize, setFontSize, onReset, onLibraryUpdated, exportFg, onExportFgChange }: Props) {
  const videoRef         = useRef<HTMLVideoElement>(null);
  const offscreen        = useRef(document.createElement("canvas"));
  const preRef           = useRef<HTMLPreElement>(null);
  const areaRef          = useRef<HTMLDivElement>(null);
  const rafRef           = useRef(0);
  const streamRef        = useRef<MediaStream | null>(null);
  const optsRef          = useRef(opts);
  const recordedRef      = useRef<AsciiFrame[]>([]);
  const liveFpsRef       = useRef(15);
  const fpsTimesRef      = useRef<number[]>([]);
  const lastFrameRef     = useRef<AsciiFrame | null>(null);
  const stageRef         = useRef<Stage>("idle");
  const fitRef           = useRef({ cols: 140, rows: 80 });
  const fontSizeRef      = useRef(fontSize);
  const updateFitRef     = useRef<() => void>(() => {});
  const colorInputRef    = useRef<HTMLInputElement>(null);
  const camQualityRef    = useRef<CamQuality>("balanced");
  const lastRenderRef    = useRef(0);
  const minFrameMsRef    = useRef(33);

  const [stage, setStageState]          = useState<Stage>("idle");
  const [capturedCount, setCapturedCount] = useState(0);
  const [error, setError]               = useState<string | null>(null);
  const [fps, setFps]                   = useState(0);
  const [recCount, setRecCount]         = useState(0);
  const [panelOpen, setPanelOpen]       = useState(() => window.innerWidth > 720);
  const [exportStatus, setExportStatus] = useState("");
  const [isMobile]                      = useState(() => window.innerWidth <= 720);
  const [fullscreen, setFullscreen]     = useState(false);
  const [camQuality, setCamQuality]     = useState<CamQuality>("balanced");
  const [showStats, setShowStats]       = useState(false);
  const [resolution, setResolution]     = useState<"480p" | "720p" | "1080p">("720p");
  const [targetFps, setTargetFps]       = useState(30);
  const [processingTime, setProcessingTime] = useState(0);
  const [wasmActive, setWasmActive]     = useState(false);

  const setStage = (s: Stage) => { stageRef.current = s; setStageState(s); };

  useEffect(() => { optsRef.current = opts; }, [opts]);

  // Detect WASM availability
  useEffect(() => {
    const checkWasm = async () => {
      try {
        const { isWasmAvailable } = await import('../lib/ascii');
        setWasmActive(isWasmAvailable());
      } catch {
        setWasmActive(false);
      }
    };
    checkWasm();
  }, []);


  const updateFit = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    const { width, height } = area.getBoundingClientRect();
    if (!width || !height) return;
    const fs = fontSizeRef.current;       // actual live font size drives char count
    fitRef.current = {
      cols: Math.max(10, Math.floor(width  / (fs * 0.575))),
      rows: Math.max(5,  Math.floor(height / (fs * 1.15))),
    };
    // Mirror into pre element so it stays fullscreen at this font size
    const pre = preRef.current;
    if (pre) pre.style.fontSize = fs + 'px';
  }, []);

  // Keep ref current so renderLoop (empty deps) always calls latest version
  useEffect(() => { updateFitRef.current = updateFit; }, [updateFit]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const obs = new ResizeObserver(updateFit);
    obs.observe(area);
    updateFit();
    return () => obs.disconnect();
  }, [updateFit]);

  useEffect(() => {
    fontSizeRef.current = fontSize;
    updateFit();          // font size changed → recalc cols/rows
  }, [fontSize, updateFit]);

  const renderLoop = useCallback(() => {
    const video = videoRef.current;
    const pre = preRef.current;
    if (!video || !pre || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(renderLoop); return;
    }

    const frameStartTime = performance.now();
    
    // FPS gate for quality modes
    const now = performance.now();
    const minMs = minFrameMsRef.current;
    if (minMs > 0 && lastRenderRef.current > 0 && now - lastRenderRef.current < minMs) {
      rafRef.current = requestAnimationFrame(renderLoop); return;
    }
    lastRenderRef.current = now;

    const q = CAM_QUALITY[camQualityRef.current];
    const baseOpts: AsciiOptions = {
      ...optsRef.current,
      asciiW: fitRef.current.cols,
      asciiH: fitRef.current.rows,
      ...(q.forceSmooth ? { temporalSmoothing: true } : {}),
      ...(q.disableHeavy ? { noiseReduction: false, localContrast: false, histEq: false } : {}),
    } as AsciiOptions;

    const result = renderToString(video, offscreen.current, baseOpts, true, "html");
    const frame = stageRef.current === "recording"
      ? processFrame(video, offscreen.current, baseOpts, true)
      : null;

    if (result) {
      if (frame) lastFrameRef.current = frame;
      const { html, isColor } = result;
      if (isColor) pre.innerHTML = html; else pre.textContent = html;
      if (stageRef.current === "recording" && frame) {
        recordedRef.current.push(frame);
        setRecCount(c => c + 1);
      }
      fpsTimesRef.current.push(now);
      if (fpsTimesRef.current.length > 30) fpsTimesRef.current.shift();
      if (fpsTimesRef.current.length > 1) {
        const f = Math.round((fpsTimesRef.current.length-1) / (now-fpsTimesRef.current[0]) * 1000);
        setFps(f);
        liveFpsRef.current = f || 15;

        // ── Adaptive font size ────────────────────────────────────────────
        // Fast → shrink font → more chars fill screen (finer detail, same fullscreen).
        // Slow → grow font  → fewer chars, less CPU.
        // Changes happen every ~60 frames so they're not jumpy.
        if (fpsTimesRef.current.length >= 20) {
          const cur = fontSizeRef.current;
          let next = cur;
          if      (f >= 28 && cur > 4)  next = cur - 1;   // fast  → finer
          else if (f < 18  && cur < 14) next = cur + 1;   // slow  → coarser
          if (next !== cur) {
            fontSizeRef.current = next;
            setFontSize(next);   // update React state → ControlsPanel shows it
            updateFitRef.current(); // recompute cols/rows immediately
            fpsTimesRef.current = []; // reset window after change
          }
        }
      }
    }
    // Track processing time
    const processingMs = performance.now() - frameStartTime;
    setProcessingTime(processingMs);
    
    rafRef.current = requestAnimationFrame(renderLoop);
  }, []);

  useEffect(() => {
    if (stage === "live" || stage === "recording") rafRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [stage, renderLoop]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = () => {
    const el = areaRef.current;
    if (!document.fullscreenElement && el) el.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const s = stageRef.current;
      if (e.code === "Space")  { e.preventDefault(); if (s === "idle") startCamera(); else if (s === "live" || s === "recording") stopAndChoose(); }
      if (e.code === "KeyR" && s === "live")      startRecording();
      if (e.code === "KeyR" && s === "recording") stopAndChoose();
      if (e.code === "KeyC" && (s === "live" || s === "recording")) captureFrame();
      if (e.code === "KeyF") toggleFullscreen();
      if (e.code === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopStream = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const setQuality = (q: CamQuality) => {
    camQualityRef.current = q;
    minFrameMsRef.current = CAM_QUALITY[q].minFrameMs;
    setCamQuality(q);
    if (q === "hq" && !optsRef.current.temporalSmoothing) {
      resetTemporalSmoothing();
    }
    // Restart camera with new constraints if already streaming
    if (stageRef.current === "live" || stageRef.current === "recording") {
      startCameraWithConstraints(q).catch(() => {});
    }
  };

  const startCameraWithConstraints = async (q: CamQuality = camQualityRef.current) => {
    const res = RESOLUTIONS[resolution];
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...CAM_QUALITY[q].video,
        width: { ideal: res.width },
        height: { ideal: res.height },
      },
      audio: false,
    });
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = stream;
    if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
    return stream;
  };

  const startCamera = async () => {
    setError(null);
    resetTemporalSmoothing();
    lastRenderRef.current = 0;
    if (window.innerWidth > 720) setPanelOpen(true);
    try {
      await startCameraWithConstraints();
      setStage("live");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Camera access denied");
    }
  };

  const stopCamera = () => {
    stopStream();
    if (preRef.current) preRef.current.innerHTML = "";
    recordedRef.current = [];
    setStage("idle"); setFps(0); setRecCount(0); setCapturedCount(0);
    fpsTimesRef.current = [];
    resetTemporalSmoothing();
  };

  const startRecording = () => { recordedRef.current = []; setRecCount(0); setStage("recording"); };

  const captureFrame = () => {
    stopStream();
    const frame = lastFrameRef.current;
    recordedRef.current = frame ? [frame] : [];
    setCapturedCount(recordedRef.current.length);
    setStage("choosing");
  };

  const stopAndChoose = () => {
    stopStream();
    setCapturedCount(recordedRef.current.length);
    setStage("choosing");
  };

  const discard = () => {
    recordedRef.current = [];
    setRecCount(0); setCapturedCount(0);
    if (preRef.current) preRef.current.innerHTML = "";
    setStage("idle");
  };

  const doExport = async (format: "txt" | "png" | "jpeg" | "gif" | "mp4") => {
    const frames = recordedRef.current;
    const isMulti = frames.length > 1;
    const o = optsRef.current;
    const bg = getExportBg(exportFg);
    setStage("exporting");
    setExportStatus(`Generating ${format.toUpperCase()}…`);
    try {
      if (format === "txt") {
        const text = frames.length ? framesToText(frames) : (preRef.current?.innerText ?? "");
        triggerDownload(new Blob([text], { type: "text/plain" }), makeFilename("ascii", "txt"));
      } else if (format === "png") {
        const f = frames[0]; if (!f) throw new Error("No frame");
        triggerDownload(await exportPng(f, fontSize, exportFg, bg, o.color), makeFilename("ascii", "png"));
      } else if (format === "jpeg") {
        const f = frames[0]; if (!f) throw new Error("No frame");
        triggerDownload(await exportJpeg(f, fontSize, exportFg, bg, o.color), makeFilename("ascii", "jpg"));
      } else if (format === "gif") {
        if (!isMulti) throw new Error("No frames for GIF");
        triggerDownload(await exportGif(frames, fontSize, exportFg, bg, o.color, liveFpsRef.current), makeFilename("ascii", "gif"));
      } else if (format === "mp4") {
        if (!isMulti) throw new Error("No frames for MP4");
        const blob = await exportMp4(frames, fontSize, exportFg, bg, o.color, liveFpsRef.current);
        triggerDownload(blob, makeFilename("ascii", blob.type.includes("webm") ? "webm" : "mp4"));
      }
      await saveToLibrary(frames, o);
      onLibraryUpdated();
      setStage("idle");
      recordedRef.current = [];
      setRecCount(0); setCapturedCount(0);
      if (preRef.current) preRef.current.innerHTML = "";
    } catch (err) {
      setExportStatus("Export failed — " + (err instanceof Error ? err.message : "unknown"));
      setTimeout(() => setStage("choosing"), 2000);
    }
  };

  const saveToLibrary = async (frames: AsciiFrame[], o: AsciiOptions) => {
    if (!frames.length) return;
    const charset = o.charset || " .:-=+*#%@";
    const frameH = frames[0].length;
    const frameW = frames[0][0]?.length ?? 0;
    const idxFrames = frames.map(f => f.map(row => row.map(c => c.charIdx)));
    const colorFrames = o.color ? frames.map(f => f.map(row => row.map(c => [c.r, c.g, c.b]))) : undefined;
    await saveLibraryItem({
      id: genId(),
      name: makeFilename(frames.length > 1 ? "rec" : "capture", "txt"),
      createdAt: Date.now(), source: "recording",
      kind: frames.length > 1 ? "video" : "image",
      charset, asciiW: frameW, asciiH: frameH,
      frameCount: idxFrames.length, frames: idxFrames, colorFrames,
      thumbnail: makeThumbnail(idxFrames, charset, frameW, frameH),
      fps: liveFpsRef.current,
    });
  };

  const isMulti = capturedCount > 1;

  const SvgFullscreen = fullscreen
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>;

  return (
    <div className="tab-content">
      <video ref={videoRef} style={{ display: "none" }} playsInline muted />

      <div className="toolbar">
        <div className="toolbar-left">
          {(stage === "live" || stage === "recording") && (
            <span className={`badge${fps < 8 ? " badge-warn" : ""}`}>{fps} fps</span>
          )}
          {stage === "recording" && <span className="badge badge-rec">REC {recCount}f</span>}
          {error && (
        <>
          <span className="badge badge-err">{error}</span>
          {/* Mobile Error Debug Panel */}
          <div style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(255, 0, 0, 0.9)',
            color: 'white',
            padding: '20px',
            borderRadius: '10px',
            maxWidth: '90%',
            zIndex: 9999,
            fontSize: '14px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            textAlign: 'center'
          }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px' }}>⚠️ Camera Error</h3>
            <p style={{ margin: '0 0 15px 0', wordBreak: 'break-word' }}>{error}</p>
            <div style={{ fontSize: '12px', marginBottom: '15px' }}>
              <strong>Troubleshooting:</strong><br/>
              1. Check camera permission<br/>
              2. Use Chrome browser<br/>
              3. Try HTTPS instead of HTTP<br/>
              4. Reload the page
            </div>
            <button 
              onClick={() => setError(null)}
              style={{
                background: 'white',
                color: 'red',
                border: 'none',
                padding: '10px 20px',
                borderRadius: '5px',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
          {(stage === "live" || stage === "recording") && (
            <span className="cam-quality-bar">
              {(["hq", "balanced", "hs"] as CamQuality[]).map(q => (
                <button
                  key={q}
                  className={`cam-quality-btn${camQuality === q ? " cam-quality-active" : ""}`}
                  onClick={() => setQuality(q)}
                  title={CAM_QUALITY[q].title}
                >
                  {CAM_QUALITY[q].label}
                </button>
              ))}
            </span>
          )}
        </div>
        <div className="toolbar-right">
          {stage === "idle" && (
            <button className="btn btn-primary" onClick={startCamera}>Start Camera</button>
          )}
          {stage === "live" && (
            <>
              <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")}>Copy</button>
              <button className="btn btn-ghost" onClick={captureFrame}>Capture</button>
              <button className="btn btn-primary" onClick={startRecording}>Record</button>
              <button className="btn btn-ghost" onClick={stopCamera}>Stop</button>
            </>
          )}
          {stage === "recording" && (
            <>
              <button className="btn btn-danger" onClick={stopAndChoose}>Stop</button>
              <button className="btn btn-ghost" onClick={discard}>Discard</button>
            </>
          )}
          {(stage === "live" || stage === "recording") && (
            <>
              <button className="btn btn-ghost" onClick={() => setShowStats(s => !s)} title="Show Stats">
                📊 {showStats ? "Hide" : "Stats"}
              </button>
              <button className="btn btn-ghost" onClick={toggleFullscreen} title="Fullscreen (F)">{SvgFullscreen}</button>
              <button className="btn btn-ghost" onClick={() => setPanelOpen(o => !o)}>Controls</button>
            </>
          )}
          <input ref={colorInputRef} type="color" value={exportFg} onChange={e => onExportFgChange(e.target.value)}
            style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }} tabIndex={-1} />
          <button className="btn btn-ghost color-pick-btn" onClick={() => colorInputRef.current?.click()} title="Export font color">
            <span className="color-swatch" style={{ background: exportFg }} />
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div ref={areaRef} className="ascii-area">
          {stage === "idle" && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={startCamera}>Start Camera</button>
              <p className="splash-hint">Live video to ASCII art, runs in your browser</p>
              <p className="splash-hint">Works offline after first load</p>
              {error && (
                <div style={{
                  background: 'rgba(255, 0, 0, 0.2)',
                  border: '2px solid #ff4444',
                  borderRadius: '8px',
                  padding: '15px',
                  marginTop: '15px',
                  maxWidth: '90%',
                  textAlign: 'center'
                }}>
                  <p style={{ color: '#ff4444', fontWeight: 'bold', margin: '0 0 10px 0' }}>
                    ⚠️ Camera Error
                  </p>
                  <p style={{ color: 'white', margin: '0 0 10px 0', wordBreak: 'break-word' }}>
                    {error}
                  </p>
                  <div style={{ 
                    fontSize: '12px', 
                    color: '#cccccc',
                    textAlign: 'left',
                    lineHeight: '1.6'
                  }}>
                    <strong>Quick Fixes:</strong><br/>
                    ✓ Grant camera permission<br/>
                    ✓ Use Chrome browser (not Kiwi)<br/>
                    ✓ Make sure no other app is using camera<br/>
                    ✓ Reload page and try again
                  </div>
                  <button 
                    onClick={() => setError(null)}
                    style={{
                      marginTop: '10px',
                      background: '#ff4444',
                      color: 'white',
                      border: 'none',
                      padding: '8px 16px',
                      borderRadius: '5px',
                      cursor: 'pointer'
                    }}
                  >
                    Close
                  </button>
                </div>
              )}
              <p className="splash-hint" style={{ marginTop: 8, fontSize: 10 }}>
                Space start/stop &nbsp; R record &nbsp; C capture &nbsp; F fullscreen &nbsp; Esc close panel
              </p>
            </div>
          )}
          <pre
            ref={preRef}
            className="ascii-output ascii-fill"
            style={{ lineHeight: "1.15" }}
          />
        </div>
        {panelOpen && (stage === "live" || stage === "recording") && (
          <div className="controls-panel-wrap">
            <ControlsPanel opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={onReset} />
          </div>
        )}
      </div>

      {/* Performance Stats Overlay */}
      {showStats && (stage === "live" || stage === "recording") && (
        <div style={{
          position: 'fixed',
          top: '10px',
          right: '10px',
          background: 'rgba(0, 0, 0, 0.95)',
          border: '2px solid #00ff00',
          borderRadius: '12px',
          padding: '15px',
          color: '#00ff00',
          fontFamily: 'monospace',
          fontSize: '13px',
          zIndex: 1000,
          minWidth: '220px',
          boxShadow: '0 4px 20px rgba(0, 255, 0, 0.3)'
        }}>
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            marginBottom: '12px',
            borderBottom: '1px solid #00ff00',
            paddingBottom: '8px'
          }}>
            <h3 style={{ margin: 0, fontSize: '16px' }}>📊 Performance</h3>
            <button 
              onClick={() => setShowStats(false)}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#00ff00',
                fontSize: '20px',
                cursor: 'pointer',
                padding: '0 5px',
                lineHeight: 1,
                opacity: 0.7
              }}
              title="Close stats"
            >
              ✕
            </button>
          </div>
          <div style={{ lineHeight: '2' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>FPS:</span>
              <strong style={{ color: fps >= 20 ? '#00ff00' : fps >= 10 ? '#ffff00' : '#ff4444' }}>{fps}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Resolution:</span>
              <strong>{RESOLUTIONS[resolution].label}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Quality:</span>
              <strong>{camQuality.toUpperCase()}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Processing:</span>
              <strong>{processingTime.toFixed(1)}ms</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>WASM:</span>
              <strong>{wasmActive ? '✅ Active' : '⚠️ JS'}</strong>
            </div>
          </div>
          <div style={{ 
            marginTop: '12px', 
            paddingTop: '8px',
            borderTop: '1px solid #00ff00',
            fontSize: '11px',
            opacity: 0.7,
            textAlign: 'center'
          }}>
            Click  to close
          </div>
        </div>
      )}

      {isMobile && (stage === "live" || stage === "recording") && (
        <div className="cam-controls-mobile">
          <button className="cam-side-btn" onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")} title="Copy">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          {stage === "live" ? (
            <>
              <button className="cam-capture-btn" onClick={captureFrame} title="Capture" />
              <button className="cam-record-btn" onClick={startRecording} title="Record">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg>
              </button>
            </>
          ) : (
            <>
              <button className="cam-side-btn" onClick={discard} title="Discard">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <button className="cam-record-btn recording" onClick={stopAndChoose} title="Stop">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              </button>
            </>
          )}
          <button className="cam-side-btn" onClick={toggleFullscreen} title="Fullscreen">{SvgFullscreen}</button>
          <button className="cam-side-btn" onClick={() => setPanelOpen(o => !o)} title="Controls">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
          </button>
        </div>
      )}

      {stage === "choosing" && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">Choose Output</div>
            <div className="modal-message">
              {isMulti ? `${capturedCount} frames recorded.` : "Single frame captured."} Select format:
            </div>
            <div className="export-grid">
              <button className="export-opt" onClick={() => doExport("txt")}><span className="export-opt-icon">TXT</span><span className="export-opt-label">Plain text</span></button>
              <button className="export-opt" onClick={() => doExport("png")}><span className="export-opt-icon">PNG</span><span className="export-opt-label">Image</span></button>
              <button className="export-opt" onClick={() => doExport("jpeg")}><span className="export-opt-icon">JPG</span><span className="export-opt-label">Image</span></button>
              {isMulti && (
                <>
                  <button className="export-opt" onClick={() => doExport("gif")}><span className="export-opt-icon">GIF</span><span className="export-opt-label">Animated</span></button>
                  <button className="export-opt" onClick={() => doExport("mp4")}><span className="export-opt-icon">MP4</span><span className="export-opt-label">Video</span></button>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={discard}>Discard</button>
            </div>
          </div>
        </div>
      )}

      {stage === "exporting" && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">Exporting</div>
            <div className="modal-message">{exportStatus}</div>
          </div>
        </div>
      )}
    </div>
  );
}
