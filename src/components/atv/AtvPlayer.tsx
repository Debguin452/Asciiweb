import { useCallback, useEffect, useRef, useState } from "react";
import { initAtvDecoder, decodeAtvFrame, tokensToFrame, type AtvDecoder } from "../../lib/atv";
import type { AtvToken } from "../../lib/atv/motion";

interface Props {
  data: Uint8Array;
  onClose?: () => void;
  title?: string;
  autoPlay?: boolean;
}

type QualityMode = "color" | "mono" | "blocks";

export default function AtvPlayer({ data, onClose, title, autoPlay = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<AtvDecoder | null>(null);
  const rafRef = useRef(0);
  const framesRef = useRef<(AtvToken[][] | null)[]>([]);
  const frameIndexRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const qualityRef = useRef<QualityMode>("color");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [fps, setFps] = useState(15);
  const [speed, setSpeed] = useState(1);
  const [quality, setQuality] = useState<QualityMode>("color");
  const [fullscreen, setFullscreen] = useState(false);
  const [stats, setStats] = useState({ cols: 0, rows: 0, size: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const renderFrame = useCallback((tokens: AtvToken[][] | null) => {
    const decoder = decoderRef.current;
    const canvas = canvasRef.current;
    if (!decoder || !canvas || !tokens) return;

    const { cols, rows, colorMode } = decoder.header;
    const qMode = qualityRef.current;
    const useColor = colorMode && qMode === "color";

    const { chars, colors } = tokensToFrame(
      tokens,
      decoder.glyphs,
      decoder.palette,
      useColor
    );

    const CW = 7, CH = 13;
    canvas.width = cols * CW;
    canvas.height = rows * CH;

    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#060606";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `bold 11px "JetBrains Mono", monospace`;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const ch = chars[y]?.[x] ?? " ";
        if (ch === " ") continue;
        if (useColor) {
          const [r, g, b] = colors[y]?.[x] ?? [57, 255, 20];
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        } else if (qMode === "mono") {
          ctx.fillStyle = "#39ff14";
        } else {
          const density = ch === "█" ? 1 : ch === "▓" ? 0.75 : ch === "▒" ? 0.5 : ch === "░" ? 0.25 : 0.5;
          const v = Math.round(density * 200 + 55);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
        }
        ctx.fillText(ch, x * CW, (y + 1) * CH - 2);
      }
    }
  }, []);

  const tick = useCallback((now: number) => {
    const decoder = decoderRef.current;
    if (!decoder || !playingRef.current) return;
    const interval = 1000 / (decoder.header.fps * speedRef.current);

    if (now - lastFrameTimeRef.current >= interval) {
      lastFrameTimeRef.current = now;
      let fi = frameIndexRef.current;
      const maxFi = decoder.header.frameCount - 1;
      fi = fi >= maxFi ? 0 : fi + 1;
      frameIndexRef.current = fi;
      setFrameIndex(fi);

      if (!framesRef.current[fi]) {
        try {
          const prev = fi > 0 ? framesRef.current[fi - 1] ?? null : null;
          framesRef.current[fi] = decodeAtvFrame(decoder, fi, prev);
        } catch { framesRef.current[fi] = framesRef.current[fi - 1] ?? null; }
      }
      renderFrame(framesRef.current[fi]);
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [renderFrame]);

  const togglePlay = useCallback(() => {
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
    if (playingRef.current) {
      lastFrameTimeRef.current = performance.now();
      rafRef.current = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafRef.current);
    }
  }, [tick]);

  const seekTo = useCallback((fi: number) => {
    const decoder = decoderRef.current;
    if (!decoder) return;
    const clamped = Math.max(0, Math.min(decoder.header.frameCount - 1, fi));
    frameIndexRef.current = clamped;
    setFrameIndex(clamped);
    if (!framesRef.current[clamped]) {
      try {
        let prev: AtvToken[][] | null = null;
        for (let i = clamped - 1; i >= 0 && !prev; i--) {
          if (framesRef.current[i]) prev = framesRef.current[i];
        }
        framesRef.current[clamped] = decodeAtvFrame(decoder, clamped, prev);
      } catch { }
    }
    renderFrame(framesRef.current[clamped]);
  }, [renderFrame]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const decoder = await initAtvDecoder(data);
        if (cancelled) return;
        decoderRef.current = decoder;
        framesRef.current = new Array(decoder.header.frameCount).fill(null);
        setTotalFrames(decoder.header.frameCount);
        setFps(decoder.header.fps);
        setStats({ cols: decoder.header.cols, rows: decoder.header.rows, size: data.length });

        framesRef.current[0] = decodeAtvFrame(decoder, 0, null);
        renderFrame(framesRef.current[0]);
        setLoading(false);

        for (let i = 1; i < Math.min(10, decoder.header.frameCount); i++) {
          const prev = framesRef.current[i - 1];
          framesRef.current[i] = decodeAtvFrame(decoder, i, prev);
        }

        if (autoPlay) {
          playingRef.current = true;
          setPlaying(true);
          lastFrameTimeRef.current = performance.now();
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Decode failed");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [data, tick, renderFrame, autoPlay]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      if (e.key === "ArrowRight") seekTo(frameIndexRef.current + 1);
      if (e.key === "ArrowLeft") seekTo(frameIndexRef.current - 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seekTo]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement && containerRef.current) {
      containerRef.current.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

  const setSpeedVal = (v: number) => { speedRef.current = v; setSpeed(v); };
  const setQualityVal = (v: QualityMode) => {
    qualityRef.current = v;
    setQuality(v);
    renderFrame(framesRef.current[frameIndexRef.current]);
  };

  const progress = totalFrames > 0 ? frameIndex / (totalFrames - 1) : 0;
  const currentTime = totalFrames > 0 && fps > 0 ? (frameIndex / fps).toFixed(1) : "0.0";
  const duration = fps > 0 ? (totalFrames / fps).toFixed(1) : "0.0";

  return (
    <div ref={containerRef} className="atv-player">
      <div className="atv-player-header">
        <span className="atv-player-title">{title ?? "ATV Player"}</span>
        <div className="atv-player-stats">
          {stats.cols}×{stats.rows} · {totalFrames}f · {(stats.size / 1024).toFixed(1)}KB
        </div>
        {onClose && (
          <button className="atv-player-close" onClick={onClose}>✕</button>
        )}
      </div>

      <div className="atv-player-viewport">
        {loading && <div className="atv-player-loading">Decoding ATV stream…</div>}
        {error && <div className="atv-player-error">{error}</div>}
        <canvas ref={canvasRef} className="atv-player-canvas" />
      </div>

      <div className="atv-player-controls">
        <div className="atv-seek-row">
          <span className="atv-time">{currentTime}s</span>
          <input
            type="range" className="atv-seek"
            min={0} max={Math.max(0, totalFrames - 1)} value={frameIndex}
            onChange={e => seekTo(Number(e.target.value))}
          />
          <span className="atv-time">{duration}s</span>
        </div>
        <div className="atv-btn-row">
          <button className="atv-btn" onClick={() => seekTo(frameIndexRef.current - 1)}>⏮</button>
          <button className="atv-btn atv-play-btn" onClick={togglePlay}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="atv-btn" onClick={() => seekTo(frameIndexRef.current + 1)}>⏭</button>

          <select
            className="atv-select"
            value={speed}
            onChange={e => setSpeedVal(Number(e.target.value))}
          >
            <option value={0.25}>0.25×</option>
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={1.5}>1.5×</option>
            <option value={2}>2×</option>
          </select>

          <select
            className="atv-select"
            value={quality}
            onChange={e => setQualityVal(e.target.value as QualityMode)}
          >
            <option value="color">Color</option>
            <option value="mono">Mono</option>
            <option value="blocks">Blocks</option>
          </select>

          <button className="atv-btn" onClick={toggleFullscreen}>
            {fullscreen ? "⊡" : "⛶"}
          </button>
        </div>
      </div>
    </div>
  );
        }
