import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { processFrame, frameToHtml, type AsciiOptions, type AsciiFrame } from "../lib/ascii";
import { saveLibraryItem, makeThumbnail, genId, type LibraryItem } from "../lib/library";
import { exportPng, exportJpeg, framesToText } from "../lib/export";
import { makeFilename, triggerDownload, getExportBg } from "../types";
import ControlsPanel from "./ControlsPanel";

interface Props {
  opts: AsciiOptions;
  updateOpt: <K extends keyof AsciiOptions>(key: K, val: AsciiOptions[K]) => void;
  fontSize: number;
  setFontSize: (n: number) => void;
  onReset: () => void;
  onLibraryUpdated: () => void;
  editItem?: LibraryItem | null;
  onEditDone?: () => void;
  exportFg: string;
  onExportFgChange: (v: string) => void;
}

interface Crop { x: number; y: number; w: number; h: number; }

type DragHandle = "tl"|"tr"|"bl"|"br"|"t"|"b"|"l"|"r"|"move";

export default function ImageTab({ opts, updateOpt, fontSize, setFontSize, onReset, onLibraryUpdated, editItem, onEditDone, exportFg, onExportFgChange }: Props) {
  const imgRef = useRef(new Image());
  const offscreen = useRef(document.createElement("canvas"));
  const preRef = useRef<HTMLPreElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cropPreviewRef = useRef<HTMLCanvasElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const lastFrameRef = useRef<AsciiFrame | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{ handle: DragHandle; startX: number; startY: number; startCrop: Crop } | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 720);
  const [fileName, setFileName] = useState("");
  const [saved, setSaved] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [showCrop, setShowCrop] = useState(false);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [activeCrop, setActiveCrop] = useState<Crop | null>(null);

  useEffect(() => {
    if (editItem) {
      setEditMode(true); setLoaded(false); setFileName(editItem.name);
      if (window.innerWidth > 720) setPanelOpen(true);
    }
  }, [editItem]);

  const renderAscii = useCallback((useCrop?: Crop | null) => {
    const pre = preRef.current;
    if (!pre) return;
    if (editMode && editItem && !loaded) {
      const srcCharset = editItem.charset || " .:-=+*#%@";
      const dstCharset = opts.charset || srcCharset;
      const srcLen = srcCharset.length;
      const dstLen = dstCharset.length;
      const frame = editItem.frames[0];
      if (!frame) return;
      const colorFrame = opts.color ? editItem.colorFrames?.[0] : undefined;
      const html = frame.map((row, y) =>
        row.map((ci, x) => {
          const ni = srcLen > 1 ? Math.round((ci / (srcLen - 1)) * (dstLen - 1)) : 0;
          const ch = dstCharset[Math.min(ni, dstLen - 1)] ?? " ";
          if (ch === " ") return "\u00a0";
          const c = colorFrame?.[y]?.[x];
          if (c) return `<span style="color:rgb(${c[0]},${c[1]},${c[2]})">${ch}</span>`;
          return ch;
        }).join("")
      ).join("\n");
      pre.innerHTML = html;
      return;
    }
    const img = imgRef.current;
    if (!img.complete || !img.naturalWidth) return;
    const cropArg = useCrop !== undefined ? useCrop : activeCrop;
    const frame = processFrame(img, offscreen.current, opts, false, cropArg ?? undefined);
    if (frame) { lastFrameRef.current = frame; pre.innerHTML = frameToHtml(frame, opts.color); }
  }, [opts, editMode, editItem, loaded, activeCrop]);

  useEffect(() => { renderAscii(); }, [renderAscii]);

  const drawCropOverlay = useCallback(() => {
    const canvas = cropPreviewRef.current;
    const img = imgRef.current;
    if (!canvas || !img.naturalWidth) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const maxW = canvas.parentElement?.clientWidth ?? 400;
    const maxH = canvas.parentElement?.clientHeight ?? 300;
    const scale = Math.min(maxW / iw, maxH / ih, 1);
    canvas.width = Math.round(iw * scale);
    canvas.height = Math.round(ih * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    if (crop) {
      const cx = crop.x * scale, cy = crop.y * scale;
      const cw = crop.w * scale, ch = crop.h * scale;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, canvas.width, cy);
      ctx.fillRect(0, cy, cx, ch);
      ctx.fillRect(cx+cw, cy, canvas.width-(cx+cw), ch);
      ctx.fillRect(0, cy+ch, canvas.width, canvas.height-(cy+ch));
      ctx.strokeStyle = "var(--fg, #39ff14)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx, cy, cw, ch);
      const handles: [number, number][] = [
        [cx, cy], [cx+cw, cy], [cx, cy+ch], [cx+cw, cy+ch],
        [cx+cw/2, cy], [cx+cw/2, cy+ch], [cx, cy+ch/2], [cx+cw, cy+ch/2],
      ];
      ctx.fillStyle = "var(--fg, #39ff14)";
      for (const [hx, hy] of handles) {
        ctx.fillRect(hx-4, hy-4, 8, 8);
      }
    }
  }, [crop]);

  useEffect(() => { if (showCrop) drawCropOverlay(); }, [showCrop, crop, drawCropOverlay]);

  const openCrop = () => {
    const img = imgRef.current;
    if (!img.naturalWidth) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const pad = 0.1;
    setCrop(activeCrop ?? { x: Math.round(iw*pad), y: Math.round(ih*pad), w: Math.round(iw*(1-pad*2)), h: Math.round(ih*(1-pad*2)) });
    setShowCrop(true);
  };

  const applyCrop = () => {
    setActiveCrop(crop);
    setShowCrop(false);
    renderAscii(crop);
  };

  const resetCrop = () => {
    setCrop(null);
    setActiveCrop(null);
    setShowCrop(false);
    renderAscii(null);
  };

  const getHandle = (e: React.MouseEvent, canvas: HTMLCanvasElement): DragHandle => {
    if (!crop) return "move";
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const iw = imgRef.current.naturalWidth, ih = imgRef.current.naturalHeight;
    const scaleX = canvas.width / iw, scaleY = canvas.height / ih;
    const cx = crop.x*scaleX, cy = crop.y*scaleY, cw = crop.w*scaleX, ch = crop.h*scaleY;
    const near = (a: number, b: number) => Math.abs(a-b) < 10;
    if (near(mx, cx)     && near(my, cy))     return "tl";
    if (near(mx, cx+cw)  && near(my, cy))     return "tr";
    if (near(mx, cx)     && near(my, cy+ch))  return "bl";
    if (near(mx, cx+cw)  && near(my, cy+ch))  return "br";
    if (near(my, cy)     && mx>cx && mx<cx+cw) return "t";
    if (near(my, cy+ch)  && mx>cx && mx<cx+cw) return "b";
    if (near(mx, cx)     && my>cy && my<cy+ch) return "l";
    if (near(mx, cx+cw)  && my>cy && my<cy+ch) return "r";
    if (mx>cx && mx<cx+cw && my>cy && my<cy+ch) return "move";
    return "move";
  };

  const onCropMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = cropPreviewRef.current; if (!canvas || !crop) return;
    const rect = canvas.getBoundingClientRect();
    const iw = imgRef.current.naturalWidth, ih = imgRef.current.naturalHeight;
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX * (iw / canvas.width);
    const my = (e.clientY - rect.top) * scaleY * (ih / canvas.height);
    const handle = getHandle(e, canvas);
    dragRef.current = { handle, startX: mx, startY: my, startCrop: { ...crop } };
    e.preventDefault();
  };

  const onCropMouseMove = useCallback((e: MouseEvent) => {
    const canvas = cropPreviewRef.current;
    if (!canvas || !dragRef.current || !crop) return;
    const rect = canvas.getBoundingClientRect();
    const iw = imgRef.current.naturalWidth, ih = imgRef.current.naturalHeight;
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const mx = (e.clientX - rect.left) * scaleX * (iw / canvas.width);
    const my = (e.clientY - rect.top) * scaleY * (ih / canvas.height);
    const dx = mx - dragRef.current.startX;
    const dy = my - dragRef.current.startY;
    const sc = dragRef.current.startCrop;
    const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const minSz = 20;
    let { x, y, w, h } = sc;
    const handle = dragRef.current.handle;
    if (handle === "move") {
      x = clampN(sc.x + dx, 0, iw - sc.w);
      y = clampN(sc.y + dy, 0, ih - sc.h);
    } else {
      if (handle === "tl" || handle === "l" || handle === "bl") { const nx = clampN(sc.x+dx, 0, sc.x+sc.w-minSz); w = sc.w-(nx-sc.x); x = nx; }
      if (handle === "tr" || handle === "r" || handle === "br") { w = clampN(sc.w+dx, minSz, iw-sc.x); }
      if (handle === "tl" || handle === "t" || handle === "tr") { const ny = clampN(sc.y+dy, 0, sc.y+sc.h-minSz); h = sc.h-(ny-sc.y); y = ny; }
      if (handle === "bl" || handle === "b" || handle === "br") { h = clampN(sc.h+dy, minSz, ih-sc.y); }
    }
    setCrop({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  }, [crop]);

  const onCropMouseUp = useCallback(() => { dragRef.current = null; }, []);

  const onCropTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    const t = e.touches[0]; if (!t) return;
    const canvas = cropPreviewRef.current; if (!canvas || !crop) return;
    const rect = canvas.getBoundingClientRect();
    const iw = imgRef.current.naturalWidth, ih = imgRef.current.naturalHeight;
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const mx = (t.clientX - rect.left) * scaleX * (iw / canvas.width);
    const my = (t.clientY - rect.top) * scaleY * (ih / canvas.height);
    const handle = getHandle({ clientX: t.clientX, clientY: t.clientY } as React.MouseEvent<HTMLCanvasElement>, canvas);
    dragRef.current = { handle, startX: mx, startY: my, startCrop: { ...crop } };
    e.preventDefault();
  }, [crop, getHandle]);

  useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]; if (!t) return;
      e.preventDefault();
      onCropMouseMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
    };
    const onTouchEnd = () => { dragRef.current = null; };
    if (showCrop) {
      window.addEventListener("mousemove", onCropMouseMove);
      window.addEventListener("mouseup", onCropMouseUp);
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("touchend", onTouchEnd);
    }
    return () => {
      window.removeEventListener("mousemove", onCropMouseMove);
      window.removeEventListener("mouseup", onCropMouseUp);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [showCrop, onCropMouseMove, onCropMouseUp, onCropTouchStart]);

  const handleFile = (file: File) => {
    setEditMode(false); onEditDone?.();
    setActiveCrop(null); setCrop(null); setShowCrop(false);
    const url = URL.createObjectURL(file);
    const img = imgRef.current;
    img.onload = () => { setLoaded(true); setFileName(file.name); setSaved(false); URL.revokeObjectURL(url); };
    img.src = url;
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = "";
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0]; if (f?.type.startsWith("image/")) handleFile(f);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "KeyS" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveTxt(); }
      if (e.code === "Escape") { setPanelOpen(false); setShowCrop(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [loaded]);

  const saveTxt = () => {
    if (!preRef.current) return;
    triggerDownload(new Blob([preRef.current.innerText], { type: "text/plain" }), makeFilename("ascii", "txt"));
  };

  const savePng = async () => {
    const frame = lastFrameRef.current; if (!frame) return;
    triggerDownload(await exportPng(frame, fontSize, exportFg, getExportBg(exportFg), opts.color), makeFilename("ascii", "png"));
  };

  const saveJpeg = async () => {
    const frame = lastFrameRef.current; if (!frame) return;
    triggerDownload(await exportJpeg(frame, fontSize, exportFg, getExportBg(exportFg), opts.color), makeFilename("ascii", "jpg"));
  };

  const saveToLibrary = async () => {
    const frame = lastFrameRef.current; if (!frame) return;
    const charset = opts.charset || " .:-=+*#%@";
    const idxFrame = frame.map(row => row.map(c => c.charIdx));
    const colorFrame = opts.color ? frame.map(row => row.map(c => [c.r, c.g, c.b])) : undefined;
    await saveLibraryItem({
      id: genId(),
      name: makeFilename(fileName ? fileName.replace(/\.[^.]+$/, "") : "ascii", "txt"),
      createdAt: Date.now(), source: "import", kind: "image",
      charset, asciiW: opts.asciiW, asciiH: opts.asciiH, frameCount: 1,
      frames: [idxFrame], colorFrames: colorFrame ? [colorFrame] : undefined,
      thumbnail: makeThumbnail([idxFrame], charset, opts.asciiW, opts.asciiH),
    });
    onLibraryUpdated();
    setSaved(true);
  };

  const isReady = loaded || (editMode && !!editItem);

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="toolbar-left">
          {isReady && <span className="badge">{fileName}</span>}
          {saved && <span className="badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> saved</span>}
          {editMode && <span className="badge badge-rec">editing</span>}
          {activeCrop && <span className="badge">cropped</span>}
        </div>
        <div className="toolbar-right">
          {isReady && (
            <>
              <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(preRef.current?.innerText ?? "")}>Copy</button>
              {!editMode && (
                <>
                  <button className="btn btn-ghost" onClick={openCrop}>{activeCrop ? "Re-crop" : "Crop"}</button>
                  {activeCrop && <button className="btn btn-ghost" onClick={resetCrop}>Reset crop</button>}
                  <button className="btn btn-ghost" onClick={saveTxt}>TXT</button>
                  <button className="btn btn-ghost" onClick={savePng}>PNG</button>
                  <button className="btn btn-ghost" onClick={saveJpeg}>JPG</button>
                  <button className="btn btn-ghost" onClick={saveToLibrary}>Save to Library</button>
                </>
              )}
              {editMode && (
                <button className="btn btn-ghost" onClick={() => { setEditMode(false); onEditDone?.(); }}>Done</button>
              )}
            </>
          )}
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
            {isReady ? "Replace" : "Upload Image"}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onFileChange} />
          {isReady && (
            <button className="btn btn-ghost" onClick={() => setPanelOpen(o => !o)}>Controls {panelOpen ? "▲" : "▼"}</button>
          )}
          <input ref={colorInputRef} type="color" value={exportFg} onChange={e => onExportFgChange(e.target.value)}
            style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }} tabIndex={-1} />
          <button className="btn btn-ghost color-pick-btn" onClick={() => colorInputRef.current?.click()} title="Export font color">
            <span className="color-swatch" style={{ background: exportFg }} />
          </button>
        </div>
      </div>

      <div className="main-layout">
        <div className="ascii-area" onDrop={onDrop} onDragOver={e => e.preventDefault()}>
          {!isReady && (
            <div className="splash">
              <button className="btn btn-primary btn-lg" onClick={() => fileInputRef.current?.click()}>Upload Image</button>
              <p className="splash-hint">Or drag and drop an image</p>
              <p className="splash-hint" style={{ fontSize: 10 }}>⌘S · save txt &nbsp; Esc · close panel</p>
            </div>
          )}
          <pre ref={preRef} className="ascii-output" style={{ fontSize: `${fontSize}px`, lineHeight: "1.15" }} />
        </div>
        {panelOpen && isReady && (
          <div className="controls-panel-wrap">
            <ControlsPanel opts={opts} updateOpt={updateOpt} fontSize={fontSize} setFontSize={setFontSize} onReset={onReset} />
          </div>
        )}
      </div>

      {showCrop && (
        <div className="modal-backdrop" onClick={() => setShowCrop(false)}>
          <div className="crop-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Crop Image</div>
            <div className="crop-canvas-wrap">
              <canvas
                ref={cropPreviewRef}
                className="crop-canvas"
                onMouseDown={onCropMouseDown}
                onTouchStart={onCropTouchStart}
                style={{ cursor: dragRef.current ? "grabbing" : "crosshair", touchAction: "none" }}
              />
            </div>
            {crop && (
              <div className="crop-info">
                {crop.x},{crop.y} &nbsp;·&nbsp; {crop.w}×{crop.h}px
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowCrop(false)}>Cancel</button>
              <button className="btn btn-ghost" onClick={resetCrop}>Reset</button>
              <button className="btn btn-primary" onClick={applyCrop}>Apply Crop</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
