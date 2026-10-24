import { LowLightAssist } from "../lib/denoise";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  renderToString, renderToPool, resetTemporalSmoothing, sortCharsetByDensity,
  getPoolCharIdx, getPoolColors, getPoolDims,
  type AsciiOptions,
} from "../lib/ascii";
import { CallManager, MAX_REMOTE_PEERS, type CallStatus, type RemoteState } from "../lib/call";
import { ColorQuantizer, fillLiftedRgba, type RemoteFrame } from "../lib/binary";
import { enhance } from "../lib/enhance";
import { FrameGovernor } from "../lib/governor";
import { record as recordPerf, sizedBucket, logSummary as logPerfSummary } from "../lib/perfStats";
import { VIDEO_CODEC_NAME, webCodecsAvailable } from "../lib/videocodec";
import CallGrid, { type GridTile } from "./CallGrid";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(k: K, v: AsciiOptions[K]) => void;
  /** Room code from an invite link (/call/CODE) — pre-fills the join box. */
  inviteCode?: string;
  /** Called once the invite has been used (or the call ended) so the URL can drop back to /call. */
  onInviteConsumed?: () => void;
  /** False while another tab is showing: the call (camera, mic, sending frames) keeps running, only painting pauses. */
  active?: boolean;
  /** Reports whether a call screen (waiting / in-call) is up, so the app can show a "call in progress" indicator elsewhere. */
  onLiveChange?: (live: boolean) => void;
}

type Screen = "home" | "starting" | "in-call";
type Facing = "user" | "environment";
type Mode   = "host" | "guest" | null;
/** ascii = plain glyphs · color = smooth color blocks (default) · pixel = coarse hard-edged pixels · color-ascii = glyphs tinted with the camera's colors */
type CallMode = "ascii" | "color" | "pixel" | "color-ascii";

const CHAR_W_RATIO = 0.575, CHAR_H_RATIO = 1.1;

// Bumped on every resize so cached layout (font size / canvas size) is recomputed lazily instead of on every frame.
let layoutEpoch = 0;

function fontSizeForGrid(el: HTMLElement | null, cols: number, rows: number): number {
  if (!el || !cols || !rows) return 8;
  const { width, height } = el.getBoundingClientRect();
  if (!width || !height) return 8;
  return Math.max(2, Math.floor(Math.min(width / (cols * CHAR_W_RATIO), height / (rows * CHAR_H_RATIO))));
}

/** Last HTML written to a <pre> by the colored-ASCII painter, so identical frames skip the DOM parse. */
const lastHtml = new WeakMap<HTMLPreElement, string>();
const cvMap  = new WeakMap<HTMLPreElement, HTMLCanvasElement>();
const imgMap = new WeakMap<HTMLCanvasElement, ImageData>();
const TILE_FIT = "cover";

function overlayCanvas(pre: HTMLPreElement): HTMLCanvasElement {
  let cv = cvMap.get(pre);
  if (!cv) {
    cv = document.createElement("canvas");
    Object.assign(cv.style, { position: "absolute", inset: "0", margin: "auto", display: "none", pointerEvents: "none" });
    cvMap.set(pre, cv);
  }
  if (!cv.isConnected || cv.previousElementSibling !== pre) pre.insertAdjacentElement("afterend", cv);
  return cv;
}

function clearPre(pre: HTMLPreElement | null) {
  if (!pre) return;
  pre.textContent = "";
  lastHtml.delete(pre);
  pre.dataset.m = "t"; pre.dataset.fk = "";
  const cv = cvMap.get(pre);
  if (cv) cv.style.display = "none";
}

function leaveCanvasMode(pre: HTMLPreElement) {
  const cv = cvMap.get(pre);
  if (cv && cv.style.display !== "none") cv.style.display = "none";
  pre.dataset.m = "t";
}

function fitFont(pre: HTMLPreElement, area: HTMLElement | null, w: number, h: number) {
  const key = `${w}x${h}@${layoutEpoch}`;
  if (pre.dataset.fk === key) return;
  const r = area?.getBoundingClientRect();
  pre.dataset.fk = r && r.width && r.height ? key : ""; // box not laid out yet → measure again next frame instead of freezing a wrong size
  pre.style.fontSize = fontSizeForGrid(area, w, h) + "px";
  pre.style.lineHeight = "1.1";
}

function paintText(pre: HTMLPreElement, area: HTMLElement | null, text: string, w: number, h: number) {
  leaveCanvasMode(pre);
  area?.classList.remove("call-area-dark");
  lastHtml.delete(pre);
  fitFont(pre, area, w, h);
  pre.textContent = text;
}

/** Color frames are w×h solid blocks, so they are drawn as a tiny image and smoothly scaled — no per-cell DOM spans. */
/** `square`: cells are square pixels (adaptive Color mode) rather than character-shaped cells. */
function paintCanvas(pre: HTMLPreElement, area: HTMLElement | null, img: ImageData | HTMLCanvasElement, square = false, pixelated = false, enhanceFrame = true) {
  const cv = overlayCanvas(pre);
  if (pre.dataset.m !== "c" || pre.firstChild) { pre.textContent = ""; lastHtml.delete(pre); pre.dataset.m = "c"; }
  if (cv.style.display !== "block") cv.style.display = "block";
  const ir = pixelated ? "pixelated" : "auto"; // pixel art keeps hard cell edges; everything else scales smoothly
  if (cv.style.imageRendering !== ir) cv.style.imageRendering = ir;
  const w = img.width, h = img.height;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const cctx = cv.getContext("2d", { willReadFrequently: true })!;
  if (img instanceof HTMLCanvasElement) {
    // `img` here is videocodec.ts's VideoReceiver.canvas — already offscreen, never DOM-attached. Priority 3 finding
    // #1 (docs/priority3-pipeline-audit.md): the original code drew it onto `cv` (the DOM-displayed overlay canvas)
    // and read THAT back, which on-device measurement showed costing far more than pixel count alone would predict —
    // consistent with the known mobile-Canvas2D cost of a displayed canvas having to sync with the GPU compositor
    // before a readback can complete. Reading `img` directly instead avoids that, AND avoids a wasted draw+redraw.
    // This call site only runs once per rAF-coalesced paint (paintRemote's caller already discards stale frames before
    // it gets here) — that throttling matters as much as where the read happens: an eager per-decoded-frame readback
    // (tried and reverted — see call.ts's videoRx.onFrame) measured far worse, because it ran once per decode instead
    // of once per display tick.
    let out: ImageData | null = null;
    if (!pixelated && enhanceFrame) {
      const srcCtx = img.getContext("2d", { willReadFrequently: true });
      if (srcCtx) {
        const t0 = performance.now();
        const data = srcCtx.getImageData(0, 0, w, h).data;
        recordPerf(sizedBucket("decode-readback", w, h), performance.now() - t0);
        out = enhance(data, w, h);
      }
    }
    if (out) cctx.putImageData(out, 0, 0);
    else cctx.drawImage(img, 0, 0); // no enhancement to apply (or couldn't get a context) — a plain draw, no readback at all
  } else {
    let out: ImageData | null = null;
    if (!pixelated && enhanceFrame) {
      const t0 = performance.now();
      out = enhance(img.data, w, h);
      recordPerf(sizedBucket("receive-enhance", w, h), performance.now() - t0);
    }
    cctx.putImageData(out ?? img, 0, 0);
  }
  if (square) {
    if (cv.dataset.k !== "fill") {
      cv.dataset.k = "fill";
      cv.style.width = "100%";
      cv.style.height = "100%";
      cv.style.objectFit = TILE_FIT;
    }
    return;
  }
  const key = `${w}x${h}c@${layoutEpoch}`;
  if (cv.dataset.k !== key) {
    const r = area?.getBoundingClientRect();
    if (r && r.width && r.height) {
      cv.dataset.k = key;
      cv.style.objectFit = "";
      const cw = CHAR_W_RATIO, ch = CHAR_H_RATIO;
      const k = Math.min(r.width / (w * cw), r.height / (h * ch));
      cv.style.width  = Math.floor(w * cw * k) + "px";
      cv.style.height = Math.floor(h * ch * k) + "px";
    }
  }
}

// Per-frame work in the paint path is dominated by allocations and string building, so everything that only depends on
// the charset or the palette is computed once and cached by identity (a palette object lives until the next keyframe).
const glyphCache = new Map<string, string[]>();
function glyphLut(charset: string, html: boolean): string[] {
  const key = (html ? "h:" : "t:") + charset;
  let l = glyphCache.get(key);
  if (!l) {
    l = Array.from(charset, c => c === " " ? "\u00a0" : html ? (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c) : c);
    if (glyphCache.size > 16) glyphCache.clear();
    glyphCache.set(key, l);
  }
  return l;
}

const spanOpenCache = new WeakMap<object, string[]>();
function spanOpens(pal: ArrayLike<number>): string[] {
  let o = spanOpenCache.get(pal);
  if (!o) {
    o = new Array(256);
    for (let i = 0; i < 256; i++) o[i] = `<span style="color:rgb(${pal[i * 3]},${pal[i * 3 + 1]},${pal[i * 3 + 2]})">`;
    spanOpenCache.set(pal, o);
  }
  return o;
}

const pal32Cache = new WeakMap<object, Uint32Array>();
function palette32(pal: ArrayLike<number>): Uint32Array {
  let p = pal32Cache.get(pal);
  if (!p) {
    p = new Uint32Array(256);
    for (let i = 0; i < 256; i++) p[i] = 0xff000000 | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3];
    pal32Cache.set(pal, p);
  }
  return p;
}

/** Colored ASCII: one <span> per run of equal palette index; blanks never break a run (their color is invisible). */
function paintColorAscii(
  pre: HTMLPreElement, area: HTMLElement | null, w: number, h: number,
  charset: string, chars: ArrayLike<number>, palette: ArrayLike<number>, colorIdx: ArrayLike<number>
) {
  const lut = glyphLut(charset, true), opens = spanOpens(palette);
  let html = "", run = -1;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const g = lut[chars[i]] ?? "\u00a0";
      if (g === "\u00a0") { html += g; continue; }
      const c = colorIdx[i];
      if (c !== run) { if (run >= 0) html += "</span>"; html += opens[c]; run = c; }
      html += g;
    }
    if (y < h - 1) html += "\n";
  }
  if (run >= 0) html += "</span>";
  leaveCanvasMode(pre);
  area?.classList.add("call-area-dark");
  fitFont(pre, area, w, h);
  if (lastHtml.get(pre) !== html) { lastHtml.set(pre, html); pre.innerHTML = html; }
}

let zeroBuf = new Uint8Array(0);
/** Pixel mode: every cell is a solid "█" in its palette color — the same look as the Camera tab's pixel view. */
function paintPixelBlocks(pre: HTMLPreElement, area: HTMLElement | null, w: number, h: number, palette: ArrayLike<number>, colorIdx: ArrayLike<number>) {
  if (zeroBuf.length < w * h) zeroBuf = new Uint8Array(w * h);
  paintColorAscii(pre, area, w, h, "█", zeroBuf, palette, colorIdx);
}

function paintRemote(frame: RemoteFrame, pre: HTMLPreElement, area: HTMLElement | null) {
  const { w, h, charset, charIndices, palette, colorIndices, isBlockColor } = frame;

  if (frame.canvas) { lastHtml.delete(pre); paintCanvas(pre, area, frame.canvas, true); return; } // real-video Color frame
  if (frame.image) { lastHtml.delete(pre); paintCanvas(pre, area, frame.image, true, frame.isPixelated); return; }

  if (isBlockColor && palette && colorIndices && frame.isPixelated) { paintPixelBlocks(pre, area, w, h, palette, colorIndices); return; }

  if (isBlockColor && palette && colorIndices) {
    const cv = overlayCanvas(pre);
    let img = imgMap.get(cv);
    if (!img || img.width !== w || img.height !== h) { img = new ImageData(w, h); imgMap.set(cv, img); }
    const pal32 = palette32(palette);
    const out = new Uint32Array(img.data.buffer);
    for (let i = 0, n = w * h; i < n; i++) out[i] = pal32[colorIndices[i]];
    lastHtml.delete(pre);
    paintCanvas(pre, area, img);
    return;
  }

  if (palette && colorIndices) { paintColorAscii(pre, area, w, h, charset, charIndices, palette, colorIndices); return; }

  const lut = glyphLut(charset, false);
  const lines: string[] = new Array(h);
  for (let y = 0; y < h; y++) {
    let line = "";
    const row = y * w;
    for (let x = 0; x < w; x++) line += lut[charIndices[row + x]] ?? "\u00a0";
    lines[y] = line;
  }
  paintText(pre, area, lines.join("\n"), w, h);
}

/** Square-pixel capture grid for adaptive Color mode: long side 192, both sides multiples of 8 (the codec's root block). */
function adaptiveDims(vw: number, vh: number, LONG = 192): { w: number; h: number } {
  const landscape = vw >= vh;
  const short = Math.max(8, Math.round(LONG * (landscape ? vh / vw : vw / vh) / 8) * 8);
  return landscape ? { w: LONG, h: short } : { w: short, h: LONG };
}

function sampleColorFrame(
  video: HTMLVideoElement, canvas: HTMLCanvasElement,
  cols: number, rows: number, mirror: boolean
): ImageData | null {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const iw = Math.max(1, cols), ih = Math.max(1, rows);
  if (canvas.width !== iw)  canvas.width  = iw;
  if (canvas.height !== ih) canvas.height = ih;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high"; // area-style downscale: less aliasing/shimmer → better colors and far smaller deltas
  ctx.save();
  if (mirror) { ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, vw, vh, -iw, 0, iw, ih); }
  else ctx.drawImage(video, 0, 0, vw, vh, 0, 0, iw, ih);
  ctx.restore();
  const t0 = performance.now();
  const img = ctx.getImageData(0, 0, iw, ih);
  recordPerf(sizedBucket("capture-readback", iw, ih), performance.now() - t0);
  return img;
}

// 19-step ramp (5 bits/char): the stock 10-step ramp bands faces into a few flat tones. Used unless the user chose a ramp of their own with ≥14 distinct chars.
const CALL_CHARSET = " .,:;-~=+*iIoxO0#%@";
const callCharset = (cs: string) => (new Set(cs || "").size >= 14 ? cs : CALL_CHARSET);

const CALL_OPTS: Partial<AsciiOptions> = {
  asciiW: 60, asciiH: 34, brightness: 0, contrast: 100,
  gamma: 1.0, temporalSmoothing: true, charDensitySort: true, color: false,
  noiseReduction: false, localContrast: false, histEq: false,
};

// The wire format carries plain char indices, so glyph modes that don't map onto the charset can't be sent.
const CALL_RENDER_FORCE: Partial<AsciiOptions> = { gradientDirs: false, brailleMode: false, blockMode: false };

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function apiCreate(peerId: string, attempts = 3): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId }),
      });
      if (r.ok) {
        const code = ((await r.json()) as { code?: string }).code;
        if (code) return code;
      } else if (r.status !== 503) {
        return null;
      }
    } catch { /* retry */ }
    if (i < attempts - 1) await sleep(400 * (i + 1));
  }
  return null;
}

async function apiUpdatePeerId(code: string, oldPeerId: string, newPeerId: string): Promise<void> {
  try {
    await fetch(`/api/rooms/${code}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId: newPeerId, replace: oldPeerId }),
    });
  } catch { /* noop — reconnect will still try the stale id, which is fine if signaling recovers */ }
}

/** Returns every other participant currently in the room (join order as the server has it), so a 3rd/4th joiner connects
 *  to everyone already there — not just whoever happened to be first, which is all a 2-person call ever needed. */
async function apiJoin(code: string, peerId: string, attempts = 4): Promise<string[] | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`/api/rooms/${code}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId }),
      });
      if (r.ok) {
        const d = await r.json() as { peers?: string[] };
        const others = (d.peers ?? []).filter(p => p !== peerId);
        if (others.length) return others;
        return null; // room exists but we're somehow the only one in it — nothing to connect to
      } else if (r.status === 404) {
        // Room may not have propagated to this edge node yet — worth a retry.
      } else {
        return null;
      }
    } catch { /* retry */ }
    if (i < attempts - 1) await sleep(500 * (i + 1));
  }
  return null;
}

async function apiLeave(code: string, peerId: string) {
  try {
    await fetch(`/api/rooms/${code}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peerId }),
    });
  } catch { /* noop */ }
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

const IconMic = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8"  y1="23" x2="16" y2="23"/>
  </svg>
);

const IconCam = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 7l-7 5 7 5V7z"/>
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
  </svg>
);

const IconCamOff = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23"/>
    <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34"/>
    <path d="M15.54 15.54A3 3 0 0 1 9 12a3 3 0 0 1 .46-1.54"/>
  </svg>
);

const IconSlash = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="2" y1="2" x2="22" y2="22"/>
  </svg>
);

const IconColor = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3"  y="3"  width="7" height="7" fill="currentColor" opacity=".8" rx="1"/>
    <rect x="14" y="3"  width="7" height="7" fill="currentColor" opacity=".5" rx="1"/>
    <rect x="3"  y="14" width="7" height="7" fill="currentColor" opacity=".4" rx="1"/>
    <rect x="14" y="14" width="7" height="7" fill="currentColor" opacity=".7" rx="1"/>
  </svg>
);

const IconPixel = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="3"  y="3"  width="5" height="5" opacity=".9"/><rect x="10" y="3"  width="5" height="5" opacity=".4"/><rect x="17" y="3"  width="4" height="5" opacity=".7"/>
    <rect x="3"  y="10" width="5" height="5" opacity=".5"/><rect x="10" y="10" width="5" height="5" opacity=".9"/><rect x="17" y="10" width="4" height="5" opacity=".5"/>
    <rect x="3"  y="17" width="5" height="4" opacity=".7"/><rect x="10" y="17" width="5" height="4" opacity=".5"/><rect x="17" y="17" width="4" height="4" opacity=".9"/>
  </svg>
);

const IconColorAscii = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2.7s6 6.1 6 10.6a6 6 0 0 1-12 0c0-4.5 6-10.6 6-10.6z"/>
  </svg>
);

const IconAscii = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="monospace">@#</text>
  </svg>
);

const CALL_MODES: { id: CallMode; label: string; hint: string; icon: ReactElement }[] = [
  { id: "ascii",       label: "ASCII",      hint: "Plain characters",          icon: IconAscii      },
  { id: "color",       label: "Color",      hint: "Detail where it matters",        icon: IconColor      },
  { id: "pixel",       label: "Pixel",      hint: "True-color pixel art",       icon: IconPixel      },
  { id: "color-ascii", label: "Color ASCII", hint: "Characters in true color", icon: IconColorAscii },
];

/** Custom drop-down (opens upward from the call bar) for choosing the display mode. */
function ModeSelect({ value, onChange }: { value: CallMode; onChange: (m: CallMode) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey  = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const cur = CALL_MODES.find(m => m.id === value) ?? CALL_MODES[1]; // default: color
  return (
    <div className="call-mode-wrap" ref={wrapRef}>
      <button
        className={`call-circle-btn${open ? " call-circle-active" : ""}`}
        onClick={() => setOpen(o => !o)}
        title="Display mode"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="call-circle-icon">{cur.icon}</span>
        <span className="call-circle-label">{cur.label} ▴</span>
      </button>
      {open && (
        <ul className="call-mode-menu" role="listbox" aria-label="Display mode">
          {CALL_MODES.map(m => (
            <li key={m.id} role="option" aria-selected={m.id === value}>
              <button
                className={`call-mode-opt${m.id === value ? " is-selected" : ""}`}
                onClick={() => { onChange(m.id); setOpen(false); }}
              >
                <span className="call-mode-opt-icon">{m.icon}</span>
                <span className="call-mode-opt-text">
                  <span className="call-mode-opt-name">{m.label}</span>
                  <span className="call-mode-opt-hint">{m.hint}</span>
                </span>
                {m.id === value && <span className="call-mode-check">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const IconFlip = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 4v6h6"/><path d="M23 20v-6h-6"/>
    <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
  </svg>
);

const IconGrid = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3"  y="3"  width="7" height="7"/>
    <rect x="14" y="3"  width="7" height="7"/>
    <rect x="3"  y="14" width="7" height="7"/>
    <rect x="14" y="14" width="7" height="7"/>
  </svg>
);

const IconFullscreen = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
  </svg>
);

const IconExitFullscreen = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
  </svg>
);

const IconEndCall = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.46 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const IconPhone = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.62 3.46 2 2 0 0 1 3.59 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.13 6.13l.92-.92a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
  </svg>
);

const IconLink = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  </svg>
);

const IconBack = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6"/>
  </svg>
);

const IconMicOff = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="1" y1="1" x2="23" y2="23"/>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
    <path d="M17 16.95A7 7 0 0 1 5 12v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8"  y1="23" x2="16" y2="23"/>
  </svg>
);

/** One remote participant's tile content — CallGrid places this wherever that participant belongs in the current layout
 *  (big, small, or a grid cell); it only has to register its own DOM nodes so the imperative paint path (onRemoteFrame,
 *  see initMgr below) can find them. It remounts (fresh DOM) whenever CallGrid's layout mode changes — registerPre/Area
 *  handle that by re-painting the last known frame immediately on mount so a tile never sits blank after a layout swap. */
function RemoteTile({ peerId, registerPre, registerArea, registerAudio }: {
  peerId: string;
  registerPre: (id: string, el: HTMLPreElement | null) => void;
  registerArea: (id: string, el: HTMLDivElement | null) => void;
  registerAudio: (id: string, el: HTMLAudioElement | null) => void;
}) {
  const areaRef  = useCallback((el: HTMLDivElement | null) => registerArea(peerId, el), [peerId, registerArea]);
  const preRef   = useCallback((el: HTMLPreElement | null) => registerPre(peerId, el), [peerId, registerPre]);
  const audioRef = useCallback((el: HTMLAudioElement | null) => registerAudio(peerId, el), [peerId, registerAudio]);
  return (
    <div className="call-tile-area" ref={areaRef}>
      <pre ref={preRef} className="ascii-output call-pre-wa" />
      <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
    </div>
  );
}

export default function CallTab({ opts, updateOpt, inviteCode = "", onInviteConsumed, active = true, onLiveChange }: Props) {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const audioRef      = useRef<HTMLAudioElement>(null);
  const offscreen     = useRef(document.createElement("canvas"));
  const colorCanvas   = useRef(document.createElement("canvas"));
  const lowLight      = useRef(new LowLightAssist()); // dim-room denoise for Color/Pixel; does nothing in good light
  const localPreRef   = useRef<HTMLPreElement>(null);
  const localAreaElRef  = useRef<HTMLDivElement | null>(null);
  const localResizeObsRef = useRef<ResizeObserver | null>(null);
  const remoteAreaRef = useRef<HTMLDivElement>(null);
  const callScreenRef = useRef<HTMLDivElement>(null);
  const rafRef        = useRef(0);
  const streamRef     = useRef<MediaStream | null>(null);
  const callRef       = useRef<CallManager | null>(null);
  const optsRef       = useRef(opts);
  const remoteFitRef  = useRef({ cols: 60, rows: 34 });
  const remoteFitColorRef = useRef({ cols: 80, rows: 45 });
  const lastFpsSetRef = useRef(0);
  const lastPreviewRef = useRef(0);
  const sendFitRef    = useRef({ cols: 60, rows: 34 }); // actual capture/send grid — see renderLoop
  const qualityScaleRef = useRef(1);
  const lastResChangeRef = useRef(0);
  const governor = useRef(new FrameGovernor());
  const myIdRef       = useRef("");
  const roomRef       = useRef("");
  const modeRef       = useRef<Mode>(null);
  const mutedRef      = useRef(false);
  const camOffRef     = useRef(false);
  const callModeRef   = useRef<CallMode>("color");
  const activeRef     = useRef(active);
  const [confirmEnd,  setConfirmEnd]  = useState(false);
  const confirmTimer  = useRef(0);
  const rgbaBuf       = useRef(new Uint8ClampedArray(0));
  const previewQuant  = useRef(new ColorQuantizer());
  const previewFrameN = useRef(0);
  const facingRef     = useRef<Facing>("user");
  const fpsT          = useRef<number[]>([]);

  // ── Group-call per-participant bookkeeping. Each remote tile paints into
  // its own <pre>/area (registered via registerPre/registerArea below) and
  // keeps its own pending-frame/raf/last-frame state, mirroring exactly what
  // the old single-remote code did with one fixed ref each — just keyed by
  // peer id now, since a tile can be unmounted/remounted (a different DOM
  // node) whenever CallGrid switches layout modes.
  const remoteTilesRef   = useRef<Map<string, { pre: HTMLPreElement | null; area: HTMLDivElement | null }>>(new Map());
  const audioElsRef      = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const pendingRemoteRef = useRef<Map<string, RemoteFrame>>(new Map());
  const remoteRafRef     = useRef<Map<string, number>>(new Map());
  const lastRemoteRef    = useRef<Map<string, RemoteFrame>>(new Map());
  const peerResScaleRef  = useRef<Map<string, number>>(new Map());
  const participantsRef  = useRef<string[]>([]);

  interface PeerUI { muted: boolean; camOff: boolean; hasFrame: boolean; reconnecting: boolean }
  const DEFAULT_PEER_UI: PeerUI = { muted: false, camOff: false, hasFrame: false, reconnecting: false };

  const [screen,       setScreen]       = useState<Screen>("home");
  const [callStatus,   setCallStatus]   = useState<CallStatus>("idle");
  const [mode,         setMode]         = useState<Mode>(null);
  const [myCode,       setMyCode]       = useState("");
  const [joinVal,      setJoinVal]      = useState("");
  const [camErr,       setCamErr]       = useState<string | null>(null);
  const [connectErr,   setConnectErr]   = useState<string | null>(null);
  const [muted,        setMuted]        = useState(false);
  const [camOff,       setCamOff]       = useState(false);
  const [facing,       setFacing]       = useState<Facing>("user");
  const [callMode,     setCallMode]     = useState<CallMode>("color");
  const [participants, setParticipants] = useState<string[]>([]);
  const [peerUI,       setPeerUI]       = useState<Record<string, PeerUI>>({});
  const [peerHungUp,   setPeerHungUp]   = useState(false);
  const [roomFullMsg,  setRoomFullMsg]  = useState(false);
  const [fps,          setFps]          = useState(0);
  const [copied,       setCopied]       = useState(false);
  const [linkCopied,   setLinkCopied]   = useState(false);
  const [joining,      setJoining]      = useState(false);
  const [starting,     setStarting]     = useState(false);
  const [fullscreen,   setFullscreen]   = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => { participantsRef.current = participants; }, [participants]);

  /** Removes a drop/closed/erroring peer from the call — shared by the "closed"/"error" status handler and onRemoteHangup
   *  below, since both mean the same thing for the UI. Only shows the "call ended" screen when that was the last person. */
  const removeParticipant = (peerId: string) => {
    const wasIn = participantsRef.current.includes(peerId);
    const wasOnly = wasIn && participantsRef.current.length === 1;
    setParticipants(prev => prev.filter(id => id !== peerId));
    if (wasOnly) setPeerHungUp(true);
    setPeerUI(prev => { if (!(peerId in prev)) return prev; const n = { ...prev }; delete n[peerId]; return n; });
    const rafId = remoteRafRef.current.get(peerId);
    if (rafId) cancelAnimationFrame(rafId);
    remoteRafRef.current.delete(peerId);
    pendingRemoteRef.current.delete(peerId);
    lastRemoteRef.current.delete(peerId);
    remoteTilesRef.current.delete(peerId);
    audioElsRef.current.delete(peerId);
    remoteStreamsRef.current.delete(peerId);
    peerResScaleRef.current.delete(peerId);
  };

  useEffect(() => { optsRef.current    = opts;       }, [opts]);
  useEffect(() => {
    callModeRef.current = callMode;
    lastResChangeRef.current = 0; // let the capture grid adopt the new mode's budget immediately
    resetTemporalSmoothing();
  }, [callMode]);
  useEffect(() => { if (inviteCode && /^[A-Z0-9]{4,16}$/.test(inviteCode)) setJoinVal(inviteCode); }, [inviteCode]);
  useEffect(() => { facingRef.current  = facing;     }, [facing]);
  useEffect(() => { mutedRef.current   = muted;      }, [muted]);
  useEffect(() => { camOffRef.current  = camOff;     }, [camOff]);

  useEffect(() => {
    Object.entries(CALL_OPTS).forEach(([k, v]) => updateOpt(k as keyof AsciiOptions, v as never));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const MIN_FONT_PX = 5;
  // Cell budget per frame. Capture/convert only runs when a frame will be sent (see renderLoop) and the heavy math is in WASM,
  // so this can be well above the old 3600; the quality level (resScale in call.ts) scales it down under congestion.
  const ASCII_MAX_CELLS = 6000, COLOR_MAX_CELLS = 8000;

  const gridForPanel = (width: number, height: number, maxCells: number) => {
    let cols = Math.max(10, Math.floor(width  / (MIN_FONT_PX * CHAR_W_RATIO)));
    let rows = Math.max(6,  Math.floor(height / (MIN_FONT_PX * CHAR_H_RATIO)));
    const cells = cols * rows;
    if (cells > maxCells) {
      const scale = Math.sqrt(maxCells / cells);
      cols = Math.max(10, Math.floor(cols * scale));
      rows = Math.max(6,  Math.floor(rows * scale));
    }
    return { cols, rows };
  };

  // Font size that fits exactly `cols`x`rows` characters into `el`'s current
  // box. Used both for our own small self-view PIP (fitting a — possibly
  // much larger — capture grid into a tiny box means a small font, which is
  // fine, it's just a thumbnail) and, per-frame, for the remote peer's pane
  // (fitting *their* actual sent resolution, whatever it is).
  const updateCallFontSize = useCallback(() => {
    // remoteFitRef is sized to *our own* remote-viewing panel — a reasonable
    // stand-in for "how much detail is actually useful", and the baseline
    // the outgoing capture resolution is built from (see renderLoop). It's
    // no longer used to set a remote tile's font size directly: the frames
    // we receive carry their own width/height (the sender's resolution,
    // which can legitimately differ from ours — different screen size, or
    // scaled down under congestion), so that's sized per-frame instead
    // (see onRemoteFrame below) to avoid a resolution/display mismatch.
    const remEl = remoteAreaRef.current;
    if (remEl) {
      const { width, height } = remEl.getBoundingClientRect();
      if (width && height) { remoteFitRef.current = gridForPanel(width, height, ASCII_MAX_CELLS); remoteFitColorRef.current = gridForPanel(width, height, COLOR_MAX_CELLS); }
      layoutEpoch++;
    }

    // The local PIP box just mirrors whatever grid we're actually sending
    // (sendFitRef, computed in renderLoop) shrunk to fit its small frame.
    if (localPreRef.current) {
      const { cols, rows } = sendFitRef.current;
      const fs = fontSizeForGrid(localAreaElRef.current, cols, rows);
      localPreRef.current.style.fontSize   = fs + "px";
      localPreRef.current.style.lineHeight = "1.1";
    }
  }, []);

  // The self-preview's wrapping element is NOT stable across a group call: CallGrid remounts it (a new DOM node) every time
  // the layout mode changes (someone joins/leaves, or a tile is tapped to focus it — including tapping your own camera to
  // "zoom" it, since that's the same tap-to-swap mechanism). A plain useRef + one-time ResizeObserver.observe() would keep
  // watching a detached element after a remount, so this is a callback ref instead: it re-attaches the one shared observer
  // to whatever element is current every time React swaps it in.
  const setLocalAreaEl = useCallback((el: HTMLDivElement | null) => {
    const obs = localResizeObsRef.current;
    if (obs && localAreaElRef.current) obs.unobserve(localAreaElRef.current);
    localAreaElRef.current = el;
    if (el) {
      layoutEpoch++; // almost certainly a new box size — don't wait for a resize event to notice
      if (!obs) localResizeObsRef.current = new ResizeObserver(updateCallFontSize);
      localResizeObsRef.current!.observe(el);
      updateCallFontSize();
    }
  }, [updateCallFontSize]);

  useEffect(() => {
    const obs = new ResizeObserver(updateCallFontSize);
    if (remoteAreaRef.current) obs.observe(remoteAreaRef.current);
    updateCallFontSize();
    return () => obs.disconnect();
  }, [updateCallFontSize, screen]);

  useEffect(() => () => localResizeObsRef.current?.disconnect(), []);

  /** Registers a remote tile's <pre>/area DOM nodes for peerId so onRemoteFrame can paint straight into them. A tile
   *  remounts (fresh DOM) whenever CallGrid's layout mode changes, same reasoning as setLocalAreaEl above — repainting the
   *  last known frame immediately on (re)mount avoids a blank tile for the one frame it'd otherwise take to catch up. */
  const registerPre = useCallback((id: string, el: HTMLPreElement | null) => {
    const t = remoteTilesRef.current.get(id) ?? { pre: null, area: null };
    t.pre = el;
    remoteTilesRef.current.set(id, t);
    if (el) {
      const fr = lastRemoteRef.current.get(id);
      if (fr) paintRemote(fr, el, remoteTilesRef.current.get(id)?.area ?? null);
    }
  }, []);
  const registerArea = useCallback((id: string, el: HTMLDivElement | null) => {
    const t = remoteTilesRef.current.get(id) ?? { pre: null, area: null };
    t.area = el;
    remoteTilesRef.current.set(id, t);
  }, []);
  const registerAudio = useCallback((id: string, el: HTMLAudioElement | null) => {
    if (el) {
      audioElsRef.current.set(id, el);
      const s = remoteStreamsRef.current.get(id);
      if (s) { el.srcObject = s; el.play().catch(() => {}); }
    } else {
      audioElsRef.current.delete(id);
    }
  }, []);

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
      onStatus: (peerId, s, detail) => {
        setCallStatus(s);
        if (s === "error")     setConnectErr(detail ?? "Connection failed");
        if (s === "connected") setConnectErr(null);
        if (s === "reconnecting") setConnectErr(null);

        if (peerId === "") return; // signaling-socket-level event (waiting/reconnecting/error on the shared Peer itself)

        if (s === "connected") {
          setScreen("in-call");
          setPeerHungUp(false);
          setParticipants(prev => prev.includes(peerId) ? prev : [...prev, peerId]);
          setPeerUI(prev => ({ ...prev, [peerId]: prev[peerId] ? { ...prev[peerId], reconnecting: false } : { ...DEFAULT_PEER_UI } }));
        } else if (s === "closed" || s === "error") {
          removeParticipant(peerId);
        } else if (s === "reconnecting") {
          setPeerUI(prev => ({ ...prev, [peerId]: { ...(prev[peerId] ?? DEFAULT_PEER_UI), reconnecting: true } }));
        }
      },
      onRemoteFrame: (peerId: string, f: RemoteFrame) => {
        lastRemoteRef.current.set(peerId, f);
        setPeerUI(prev => (prev[peerId]?.hasFrame ? prev : { ...prev, [peerId]: { ...(prev[peerId] ?? DEFAULT_PEER_UI), hasFrame: true } }));
        // Paint at most once per display frame, always the newest — a burst after a stall no longer costs N full repaints.
        pendingRemoteRef.current.set(peerId, f);
        if (!remoteRafRef.current.has(peerId)) {
          const rafId = requestAnimationFrame(() => {
            remoteRafRef.current.delete(peerId);
            const fr = pendingRemoteRef.current.get(peerId); pendingRemoteRef.current.delete(peerId);
            const tile = remoteTilesRef.current.get(peerId);
            if (fr && tile?.pre && activeRef.current) {
              const t0 = performance.now();
              paintRemote(fr, tile.pre, tile.area);
              governor.current.notePaint(performance.now() - t0);
            }
          });
          remoteRafRef.current.set(peerId, rafId);
        }
      },
      onRemoteHangup: (peerId: string) => removeParticipant(peerId),
      onRemoteStream: (peerId: string, s: MediaStream) => {
        remoteStreamsRef.current.set(peerId, s);
        const el = audioElsRef.current.get(peerId);
        if (el) { el.srcObject = s; el.play().catch(() => {}); }
      },
      onRemoteState: (peerId: string, state: RemoteState) => {
        setPeerUI(prev => ({ ...prev, [peerId]: { ...(prev[peerId] ?? DEFAULT_PEER_UI), muted: state.micMuted, camOff: state.camOff } }));
      },
      onQualityChange: (peerId, _level, step) => {
        // Drives the actual capture/send resolution (see renderLoop) — the
        // most constrained currently-connected peer governs it, same
        // reasoning as the old single-peer version, just taking the min
        // across everyone now instead of there only ever being one.
        peerResScaleRef.current.set(peerId, step.resScale);
        let min = 1;
        for (const v of peerResScaleRef.current.values()) min = Math.min(min, v);
        qualityScaleRef.current = min;
      },
      onIdChanged: (newId, oldId) => {
        myIdRef.current = newId;
        if (roomRef.current) apiUpdatePeerId(roomRef.current, oldId, newId).catch(() => {});
      },
      onRoomFull: () => {
        setRoomFullMsg(true);
        setTimeout(() => setRoomFullMsg(false), 3000);
      },
    });
    callRef.current = mgr;
    mgr.start().then(id => { myIdRef.current = id; }).catch(() => {});
  }, []);

  useEffect(() => { initMgr(); return () => callRef.current?.hangup(); }, [initMgr]);

  useEffect(() => {
    const g = governor.current;
    g.onChange(s => callRef.current?.setFpsCap(s.fpsCap));
    g.reset();
    return () => g.onChange(() => {});
  }, []);

  const accountFrame = useCallback((startedAt: number, workMs: number) => {
    const mgr = callRef.current;
    const gov = governor.current.state;
    const target = Math.min(mgr?.isConnected ? mgr.currentFps : 30, gov.fpsCap, 30);
    governor.current.noteWork(workMs, 1000 / target, performance.now());
    fpsT.current.push(startedAt);
    if (fpsT.current.length > 30) fpsT.current.shift();
    if (fpsT.current.length > 1 && startedAt - lastFpsSetRef.current > 500) {
      lastFpsSetRef.current = startedAt;
      setFps(Math.round((fpsT.current.length - 1) / ((startedAt - fpsT.current[0]) / 1000)));
    }
  }, []);

  const renderLoop = useCallback(() => {
    rafRef.current = requestAnimationFrame(renderLoop);
    const video = videoRef.current, pre = localPreRef.current;
    if (!video || !pre || video.readyState < 2 || camOffRef.current) return;

    // Capture → convert → paint only when a frame will actually go out (or, before the call connects, at a modest preview rate).
    // This used to run at the display refresh rate (60-120 Hz) and discard most of the work in the send throttle.
    const mgr = callRef.current;
    const now = performance.now();
    const callMode = callModeRef.current;
    if (mgr?.isConnected) { if (!mgr.isSendDue()) return; }
    else if (now - lastPreviewRef.current < 66) return;
    lastPreviewRef.current = now;
    const gov = governor.current.state;
    const show = activeRef.current && governor.current.shouldPaintSelf(now);

    const isMirror = facingRef.current === "user";

    const base  = callMode === "color" ? remoteFitColorRef.current : remoteFitRef.current; // Pixel uses the character grid, like ASCII
    const scale = qualityScaleRef.current * gov.scaleMul;
    const cols  = Math.max(14, Math.round(base.cols * scale));
    const rows  = Math.max(8,  Math.round(base.rows * scale));
    if ((cols !== sendFitRef.current.cols || rows !== sendFitRef.current.rows) && now - lastResChangeRef.current > 1200) {
      lastResChangeRef.current = now;
      sendFitRef.current = { cols, rows };
    }
    const pip = sendFitRef.current;

    let produced = false;
    if (callMode === "color") {
      // Real video (WebCodecs) when both peers support it: far better quality per byte, and it uses a bigger capture size.
      // Otherwise the adaptive quadtree codec on a 192-px grid.
      const plan = mgr?.isConnected ? mgr.videoPlan(video.videoWidth, video.videoHeight, gov.scaleMul) : null;
      const d = plan ?? adaptiveDims(video.videoWidth, video.videoHeight, Math.max(96, Math.min(192, Math.round(192 * gov.scaleMul / 8) * 8)));
      const img = video.videoWidth ? sampleColorFrame(video, colorCanvas.current, d.w, d.h, isMirror) : null;
      if (img) {
        if (gov.lowLight) lowLight.current.process(img.data, img.width, img.height);
        if (show) {
          const t = performance.now();
          paintCanvas(pre, localAreaElRef.current, img, true, false, false);
          governor.current.noteSelfPaint(performance.now() - t, t);
          localAreaElRef.current?.classList.remove("call-area-dark");
        }
        if (mgr?.isConnected) {
          if (!(plan && mgr.sendVideoFrame(img.data, img.width, img.height))) {
            if (plan) { /* video just became unusable — this frame is at the video size, so let the next one use the quadtree grid */ }
            else mgr.sendAdaptiveFrame(img.data, img.width, img.height);
          }
        }
        produced = true;
      }
    } else if (callMode === "pixel") {
      // Pixel art rides the same adaptive true-color codec as Color mode, just on a coarse grid shown with hard cell edges.
      const long = Math.max(40, Math.min(96, Math.round(96 * scale / 8) * 8));
      const d = adaptiveDims(video.videoWidth, video.videoHeight, long);
      const img = video.videoWidth ? sampleColorFrame(video, colorCanvas.current, d.w, d.h, isMirror) : null;
      if (img) {
        if (gov.lowLight) lowLight.current.process(img.data, img.width, img.height);
        if (show) {
          const t = performance.now();
          paintCanvas(pre, localAreaElRef.current, img, true, true, false);
          governor.current.noteSelfPaint(performance.now() - t, t);
          localAreaElRef.current?.classList.remove("call-area-dark");
        }
        if (mgr?.isConnected) mgr.sendAdaptiveFrame(img.data, img.width, img.height, true);
        produced = true;
      }
    } else {
      const o = optsRef.current;
      const cs = callCharset(o.charset);
      const withColor = callMode === "color-ascii";
      const ropts = { ...o, ...CALL_OPTS, ...CALL_RENDER_FORCE, charset: cs, asciiW: pip.cols, asciiH: pip.rows, color: withColor };

      if (withColor) {
        const res = renderToPool(video, offscreen.current, ropts, isMirror);
        const { w, h } = getPoolDims();
        if (res && w > 0 && h > 0) {
          const N = w * h;
          if (rgbaBuf.current.length < N * 4) rgbaBuf.current = new Uint8ClampedArray(N * 4);
          const { r, g, b } = getPoolColors();
          fillLiftedRgba(rgbaBuf.current, r, g, b, N);
          const sorted = res.chars;
          const raw = getPoolCharIdx();
          let q: { palette: Uint8Array; indices: Uint8Array } | null = null;
          if (mgr?.isConnected) q = mgr.sendAsciiColorFrame(raw, w, h, sorted, rgbaBuf.current);
          else {
            // Not connected yet: quantize locally so the preview looks exactly like what the peer will get.
            const lq = previewQuant.current.quantize(rgbaBuf.current, N, previewFrameN.current++ % 45 === 0);
            q = { palette: lq.palette, indices: lq.indices };
          }
          if (q) {
            if (show) {
              const t = performance.now();
              paintColorAscii(pre, localAreaElRef.current, w, h, sorted, raw, q.palette, q.indices);
              governor.current.noteSelfPaint(performance.now() - t, t);
            }
            produced = true;
          }
        }
      } else {
        const result = renderToString(video, offscreen.current, ropts, isMirror, "text");
        if (result) {
          const { w, h } = getPoolDims();
          if (w > 0 && h > 0) {
            if (show) {
              const t = performance.now();
              paintText(pre, localAreaElRef.current, result.html, w, h);
              governor.current.noteSelfPaint(performance.now() - t, t);
            }
            if (mgr?.isConnected) {
              const raw = getPoolCharIdx();
              mgr.sendAsciiFrame(raw.length === w * h ? raw : raw.subarray(0, w * h), w, h, sortCharsetByDensity(cs));
            }
            produced = true;
          }
        }
      }
    }

    if (produced) accountFrame(now, performance.now() - now);
  }, [accountFrame]);

  useEffect(() => {
    if (screen !== "home") rafRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [screen, renderLoop]);

  // The call survives tab switches (App keeps this component mounted); while hidden we keep capturing + sending but skip painting.
  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    const id = requestAnimationFrame(() => {
      layoutEpoch++; // the panels were display:none — re-measure everything
      updateCallFontSize();
      for (const [peerId, fr] of lastRemoteRef.current) {
        const tile = remoteTilesRef.current.get(peerId);
        if (tile?.pre) paintRemote(fr, tile.pre, tile.area);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active, updateCallFontSize]);

  useEffect(() => { onLiveChange?.(screen !== "home"); }, [screen, onLiveChange]);
  useEffect(() => () => { onLiveChange?.(false); clearTimeout(confirmTimer.current); }, [onLiveChange]);

  // Every screen renders its own <video>, so the stream attached before a screen change is left on an unmounted element —
  // re-attach it to the new one (this is why the camera stayed blank after connecting until Flip re-ran startCam).
  useEffect(() => {
    const v = videoRef.current, st = streamRef.current;
    if (v && st && v.srcObject !== st) { v.srcObject = st; v.play().catch(() => {}); }
  }, [screen]);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  // Priority 3 item 17 measurement phase only (see perfStats.ts / docs/priority3-pipeline-audit.md) — prints the
  // readback/enhance timing breakdown to the console every 10s during a call, so numbers can be read straight off a
  // phone's remote-debugging console without needing to call `__perfStats.logSummary()` manually. Safe to delete once
  // the measurement phase is done; it only reads timing data, never changes behavior.
  useEffect(() => {
    if (screen !== "in-call") return;
    const id = setInterval(() => {
      // Which codec each peer pairing actually landed on — "decode-readback" only ever gets written when a peer is on
      // a video codec (null below means that peer fell back to the quadtree codec, which never does a receive-side
      // readback at all; see call.ts's PeerSession.getStats()).
      const codecs = callRef.current?.getStats();
      const codecStr = codecs
        ? Object.entries(codecs).map(([id, s]) => {
            const neg = s.videoCodec === null ? "quadtree" : VIDEO_CODEC_NAME[s.videoCodec];
            // When it's quadtree, say WHY: no local encoder support at all, no codec the remote can decode, or a
            // shared codec existed but something else blocked it (error/disabled — see PeerSession.videoCodec).
            const why = s.videoCodec !== null ? "" :
              !webCodecsAvailable() ? " (no WebCodecs API)" :
              s.localEncoders.length === 0 ? " (this device can't encode any supported codec)" :
              !s.remoteDecoders || s.remoteDecoders.length === 0 ? " (remote hasn't reported decode support yet, or can't decode any)" :
              s.localEncoders.some(c => s.remoteDecoders!.includes(c)) ? " (shared codec exists but is disabled/errored)" :
              ` (no overlap: we encode [${s.localEncoders.map(c => VIDEO_CODEC_NAME[c]).join(",")}], they decode [${s.remoteDecoders.map(c => VIDEO_CODEC_NAME[c]).join(",")}])`;
            return `${id.slice(0, 6)}:${neg}${why}`;
          }).join(" ")
        : "";
      logPerfSummary(`mode=${callModeRef.current} tiles=${participants.length} codecs=[${codecStr}]`);
    }, 10000);
    return () => clearInterval(id);
  }, [screen, participants.length]);

  // Returns whether the camera actually started — callers must check this
  // (this used to throw-swallow internally, which meant `try { await
  // startCam() } catch` in startCall()/joinCall() never actually caught
  // anything: a failed camera silently let the call proceed anyway).
  //
  // Also retries once on NotReadableError/TrackStartError specifically —
  // Android Chrome commonly throws that for a brief moment right after a
  // previous MediaStream's tracks are stopped, because the OS hasn't
  // released the camera hardware handle yet. That race is exactly why
  // "close the call and start again" used to fix it: by the second
  // attempt the handle was free. Retrying here once, a moment later, does
  // the same thing automatically instead of making the person notice and
  // back out manually.
  const startCam = async (face: Facing = facing): Promise<boolean> => {
    lowLight.current.reset(); // new camera/stream: forget the old noise reading and running average
    setCamErr(null);
    if (videoRef.current) videoRef.current.srcObject = null;
    // Keep the live mic track across camera flips: the call's audio sender is bound to that exact track,
    // so stopping + re-acquiring it silently killed the peer's audio after every flip.
    const keepAudio = streamRef.current?.getAudioTracks().find(t => t.readyState === "live") ?? null;
    streamRef.current?.getVideoTracks().forEach(t => t.stop());
    if (!keepAudio) streamRef.current?.getAudioTracks().forEach(t => t.stop());
    streamRef.current = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: face, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
          audio: keepAudio ? false : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (keepAudio) s.addTrack(keepAudio);
        streamRef.current = s;
        if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play(); }
        callRef.current?.answerWithStream(s);
        setCamOff(false);
        return true;
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (attempt === 0 && (name === "NotReadableError" || name === "TrackStartError")) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        setCamErr(e instanceof Error ? e.message : "Camera denied");
        return false;
      }
    }
    return false;
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
    if (!camOff) clearPre(localPreRef.current);
    callRef.current?.sendState(mutedRef.current, newCamOff);
  };

  const startCall = async () => {
    setStarting(true); setCamErr(null); setConnectErr(null);

    const camOk = await startCam();
    if (!camOk) { setStarting(false); return; }

    let attempts = 0;
    while (!myIdRef.current && attempts < 20) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    if (!myIdRef.current) {
      setConnectErr("Connection system failed. Check internet.");
      setStarting(false); return;
    }

    const code = await apiCreate(myIdRef.current);
    if (!code) {
      setConnectErr("Couldn't create a room code. Check your connection and try again.");
      setStarting(false); return;
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
    if (inviteCode) onInviteConsumed?.();

    if (screen === "home") {
      await startCam();
      modeRef.current = "guest"; setMode("guest"); setScreen("starting");
    }

    // myIdRef is only set once the signaling peer finishes connecting
    // (see initMgr's mgr.start().then(...)), which is async and not
    // guaranteed to have resolved yet — e.g. pasting a code and hitting
    // Join right after the page loads. Without this wait, apiJoin was
    // sent with peerId: "", the API rejected it (400), and the guest saw
    // a misleading "Couldn't find that call code" even for a valid code.
    let waited = 0;
    while (!myIdRef.current && waited < 10000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    if (!myIdRef.current) {
      setConnectErr("Connection system failed. Check internet.");
      setJoining(false);
      return;
    }

    // Every other peer already in the room (join order) — not just the first, so a 3rd/4th joiner reaches everyone.
    const others = await apiJoin(code, myIdRef.current);
    if (others && others.length) {
      if (others.length > MAX_REMOTE_PEERS) {
        // A race let the room fill up between us checking and us joining — leave it rather than connect to nobody.
        await apiLeave(code, myIdRef.current).catch(() => {});
        setConnectErr("This call is already full (4 people max).");
      } else {
        callRef.current?.connectToAll(others, streamRef.current);
        roomRef.current = code;
      }
    } else {
      setConnectErr("Couldn't find that call code. Check it and try again.");
    }

    setJoining(false);
  };

  const endCall = async () => {
    if (roomRef.current && myIdRef.current) await apiLeave(roomRef.current, myIdRef.current).catch(() => {});
    roomRef.current = ""; modeRef.current = null;
    callRef.current?.hangup();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current)  videoRef.current.srcObject = null;
    clearPre(localPreRef.current);
    for (const rafId of remoteRafRef.current.values()) cancelAnimationFrame(rafId);
    remoteRafRef.current.clear();
    pendingRemoteRef.current.clear();
    lastRemoteRef.current.clear();
    remoteTilesRef.current.clear();
    audioElsRef.current.clear();
    remoteStreamsRef.current.clear();
    peerResScaleRef.current.clear();
    participantsRef.current = [];
    setParticipants([]); setPeerUI({});
    setScreen("home"); setCallStatus("idle");
    setPeerHungUp(false); setRoomFullMsg(false);
    setMode(null); setMyCode(""); setJoinVal(""); setFps(0); fpsT.current = [];
    setMuted(false); setCamOff(false);
    resetTemporalSmoothing();
    setTimeout(initMgr, 300);
    if (inviteCode) onInviteConsumed?.();
  };

  /** Ending a live call takes two taps (3 s window) — a stray touch shouldn't hang up on someone. */
  const requestEnd = () => {
    if (confirmEnd) { clearTimeout(confirmTimer.current); setConfirmEnd(false); endCall(); return; }
    setConfirmEnd(true);
    clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirmEnd(false), 3000);
    try { navigator.vibrate?.(18); } catch { /* not supported */ }
  };

  const callLink = () => `${window.location.origin}/call/${myCode}`;
  const shareLink = async () => {
    const url = callLink();
    try {
      if (navigator.share) { await navigator.share({ title: "Join my asciiweb call", text: "Join my ASCII video call:", url }); return; }
    } catch (e) { if (e instanceof DOMException && e.name === "AbortError") return; }
    navigator.clipboard.writeText(url).catch(() => {});
    setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000);
  };

  const copyCode = () => {
    navigator.clipboard.writeText(myCode).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  if (screen === "home") {
    // Arrived through an invite link: Join is the obvious action, so it gets the highlight and comes first.
    const invited = !!inviteCode && joinVal === inviteCode;
    const startBtn = (
      <button className={`call-big-btn ${invited ? "call-big-secondary" : "call-big-primary"}`} onClick={startCall} disabled={starting}>
        {starting ? <><span className="call-btn-spinner" />Starting…</> : <>{IconPhone} Start a call</>}
      </button>
    );
    const joinBlock = (
      <div className="call-join-area">
        <input
          className="call-code-input"
          placeholder="Enter code"
          value={joinVal}
          onChange={e => setJoinVal(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          onKeyDown={e => e.key === "Enter" && joinVal.length > 3 && joinCall()}
          maxLength={16}
          spellCheck={false}
          autoCapitalize="characters"
        />
        <button
          className={`call-big-btn ${invited ? "call-big-primary" : "call-big-secondary"}`}
          onClick={joinCall}
          disabled={joinVal.length < 4 || joining}
        >
          {joining ? <><span className="call-btn-spinner" />Joining…</> : <>{IconLink} Join</>}
        </button>
      </div>
    );

    return (
      <div key="screen-home" className="call-home">
        <div className="call-home-inner">
          <div className="call-home-hero">
            <div className="call-home-logo">ASCII</div>
            <div className="call-home-logo-sub">Video Call</div>
            <p className="call-home-desc">Face-to-face in ASCII art. No account. No download.</p>
          </div>
          <div className="call-home-actions">
            {invited && (
              <p className="call-invite-note">You’ve been invited to call <strong>{inviteCode}</strong> — tap Join.</p>
            )}
            {invited ? joinBlock : startBtn}
            <div className="call-home-or">{invited ? "or start your own" : "or"}</div>
            {invited ? startBtn : joinBlock}
          </div>
          {camErr     && <p className="call-home-err">{camErr}</p>}
          {connectErr && <p className="call-home-err">{connectErr}</p>}
        </div>
      </div>
    );
  }

  if (screen === "starting" && mode === "host") {
    return (
      <div key="screen-waiting" className="call-waiting-screen">
        <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
        <video ref={videoRef} playsInline muted style={{ display: "none" }} />
        <div className="call-wait-top" ref={setLocalAreaEl}>
          <pre ref={localPreRef} className="ascii-output call-pre-fill" style={{ lineHeight: "1.1" }} />
          {camErr && <div className="call-cam-err">{camErr}</div>}
        </div>
        <div className="call-wait-bottom">
          <p className="call-wait-label">Your call code — share it</p>
          <div className="call-code-display">
            {myCode.split("").map((ch, i) => <span key={i} className="call-code-char">{ch}</span>)}
          </div>
          <div className="call-copy-row">
            <button className="call-copy-btn" onClick={copyCode}>{copied ? "Copied!" : "Copy code"}</button>
            <button className="call-copy-btn" onClick={shareLink}>{linkCopied ? "Link copied!" : typeof navigator !== "undefined" && "share" in navigator ? "Share link" : "Copy link"}</button>
          </div>
          <p className="call-wait-hint">Waiting for the other person to join…</p>
          {callStatus === "connecting" && (
            <p className="call-connecting-msg"><span className="call-btn-spinner" />Connecting…</p>
          )}
          {connectErr && <p className="call-home-err">{connectErr}</p>}
          <button className="call-cancel-btn" onClick={endCall}>{IconBack} Back</button>
        </div>
      </div>
    );
  }

  if (screen === "starting" && mode === "guest") {
    return (
      <div key="screen-waiting" className="call-waiting-screen">
        <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
        <video ref={videoRef} playsInline muted style={{ display: "none" }} />
        <div className="call-wait-top" ref={setLocalAreaEl}>
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
                <input
                  className="call-code-input"
                  placeholder="Re-enter code"
                  value={joinVal}
                  onChange={e => setJoinVal(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  onKeyDown={e => e.key === "Enter" && joinVal.length > 3 && joinCall()}
                  maxLength={16}
                  autoCapitalize="characters"
                  spellCheck={false}
                />
                <button className="call-big-btn call-big-secondary call-big-sm" onClick={joinCall} disabled={joinVal.length < 4 || joining}>
                  {joining ? "…" : "Retry"}
                </button>
              </div>
            </>
          )}
          <button className="call-cancel-btn" onClick={endCall}>{IconBack} Back</button>
        </div>
      </div>
    );
  }

  return (
    <div key="screen-active" className="call-active" ref={callScreenRef}>
      <audio ref={audioRef} autoPlay playsInline style={{ display: "none" }} />
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />

      <div ref={remoteAreaRef} className="call-panels-wa">
        {(callStatus === "reconnecting" || Object.values(peerUI).some(u => u.reconnecting)) && (
          <div className="call-reconnect-banner">
            <span className="call-btn-spinner" />Reconnecting…
          </div>
        )}

        {roomFullMsg && (
          <div className="call-reconnect-banner call-room-full-banner">This call is full — 4 people max</div>
        )}

        {participants.length === 0 ? (
          <>
            {peerHungUp ? (
              <div className="call-peer-hung-up">
                {IconEndCall}
                <p>Call ended</p>
                <button className="call-cancel-btn" onClick={endCall}>{IconBack} Back</button>
              </div>
            ) : (
              <div className="call-panel-waiting">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35 }}>
                  <circle cx="12" cy="12" r="10" strokeDasharray="4 2"/>
                  <circle cx="12" cy="8"  r="1.5" fill="currentColor"/>
                  <path d="M12 12v4"/>
                </svg>
                <p>Connecting to peer…</p>
              </div>
            )}
            {/* Nobody's joined yet — a simple floating self-preview, same spot CallGrid's pip mode uses once someone has. */}
            <div className="call-panel-wa-local" ref={setLocalAreaEl}>
              {fps > 0 && <span className="call-pip-fps">{fps}fps</span>}
              <pre ref={localPreRef} className="ascii-output call-pre-pip" />
            </div>
          </>
        ) : (
          <CallGrid
            tiles={[
              {
                id: "self", isSelf: true, muted, camOff,
                content: (
                  <div className="call-tile-local-area" ref={setLocalAreaEl}>
                    {fps > 0 && <span className="call-pip-fps">{fps}fps</span>}
                    <pre ref={localPreRef} className="ascii-output call-pre-pip" />
                  </div>
                ),
              },
              ...participants.map((id): GridTile => ({
                id, isSelf: false, muted: peerUI[id]?.muted, camOff: peerUI[id]?.camOff, waiting: !peerUI[id]?.hasFrame && !peerUI[id]?.camOff,
                content: <RemoteTile peerId={id} registerPre={registerPre} registerArea={registerArea} registerAudio={registerAudio} />,
              })),
            ]}
          />
        )}

        {showSettings && (
          <div className="call-settings-overlay" onClick={() => setShowSettings(false)}>
            <div className="call-settings-panel" onClick={e => e.stopPropagation()}>
              <div className="call-settings-title">Detail Level</div>
              <div className="call-settings-row">
                <span>Sending at</span>
                <span className="call-settings-val">{sendFitRef.current.cols}×{sendFitRef.current.rows}</span>
              </div>
              <div className="call-settings-hint">
                Automatically scaled to your screen and current connection quality.
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
            {IconMic}
            {muted && (
              <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {IconSlash}
              </span>
            )}
          </span>
          <span className="call-circle-label">{muted ? "Unmute" : "Mic"}</span>
        </button>

        <button
          className={`call-circle-btn${camOff ? " call-circle-danger" : ""}`}
          onClick={toggleCam}
          title={camOff ? "Camera off" : "Camera on"}
        >
          <span className="call-circle-icon">{camOff ? IconCamOff : IconCam}</span>
          <span className="call-circle-label">{camOff ? "Off" : "Camera"}</span>
        </button>

        <ModeSelect value={callMode} onChange={setCallMode} />

        <button className="call-circle-btn" onClick={flipCam} title="Flip camera">
          <span className="call-circle-icon">{IconFlip}</span>
          <span className="call-circle-label">Flip</span>
        </button>

        <button
          className={`call-circle-btn${showSettings ? " call-circle-active" : ""}`}
          onClick={() => setShowSettings(s => !s)}
          title="Grid settings"
        >
          <span className="call-circle-icon">{IconGrid}</span>
          <span className="call-circle-label">Grid</span>
        </button>

        <button className="call-circle-btn" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
          <span className="call-circle-icon">{fullscreen ? IconExitFullscreen : IconFullscreen}</span>
          <span className="call-circle-label">{fullscreen ? "Exit" : "Full"}</span>
        </button>

        <button className={`call-circle-btn call-circle-end${confirmEnd ? " call-circle-confirm" : ""}`} onClick={requestEnd} title={confirmEnd ? "Tap again to end the call" : "End call"}>
          <span className="call-circle-icon">{IconEndCall}</span>
          <span className="call-circle-label">{confirmEnd ? "Tap again" : "End"}</span>
        </button>
      </div>
    </div>
  );
}
