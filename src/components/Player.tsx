import { useEffect, useRef, useState } from "react";
import { frameToHtml } from "../lib/ascii";
import type { LibraryItem } from "../lib/library";

interface Props {
  item: LibraryItem;
  fontSize: number;
}

export default function Player({ item, fontSize }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const playingRef = useRef(false);
  const frameIdxRef = useRef(0);
  const fps = item.fps ?? 15;

  const charset = item.charset || " .:-=+*#%@";

  const renderFrame = (idx: number) => {
    const pre = preRef.current;
    if (!pre) return;
    const frame = item.frames[idx];
    if (!frame) return;
    const colorFrame = item.colorFrames?.[idx];
    const html = colorFrame
      ? frame.map((row, y) =>
          row.map((ci, x) => {
            const c = colorFrame[y]?.[x];
            const ch = charset[ci] ?? " ";
            if (ch === " ") return "\u00a0";
            if (!c) return ch;
            return `<span style="color:rgb(${c[0]},${c[1]},${c[2]})">${ch}</span>`;
          }).join("")
        ).join("\n")
      : frame.map(row =>
          row.map(ci => {
            const ch = charset[ci] ?? " ";
            return ch === " " ? "\u00a0" : ch;
          }).join("")
        ).join("\n");
    pre.innerHTML = html;
  };

  useEffect(() => {
    renderFrame(0);
  }, [item]);

  useEffect(() => {
    renderFrame(frameIdx);
  }, [frameIdx]);

  const tick = (ts: number) => {
    if (!playingRef.current) return;
    const interval = 1000 / fps;
    if (ts - lastTimeRef.current >= interval) {
      lastTimeRef.current = ts;
      const next = (frameIdxRef.current + 1) % item.frameCount;
      frameIdxRef.current = next;
      setFrameIdx(next);
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const play = () => {
    playingRef.current = true;
    setPlaying(true);
    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  };

  const pause = () => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const scrub = (v: number) => {
    pause();
    frameIdxRef.current = v;
    setFrameIdx(v);
  };

  return (
    <div className="player">
      <pre
        ref={preRef}
        className="ascii-output"
        style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }}
      />
      {item.kind === "video" && item.frameCount > 1 && (
        <div className="player-controls">
          <button className="btn btn-ghost btn-sm" onClick={playing ? pause : play}>
            {playing ? "⏸" : "▶"}
          </button>
          <input
            type="range"
            className="slider player-scrub"
            min={0}
            max={item.frameCount - 1}
            value={frameIdx}
            onChange={e => scrub(Number(e.target.value))}
          />
          <span className="player-frame-count">{frameIdx + 1} / {item.frameCount}</span>
        </div>
      )}
    </div>
  );
}
