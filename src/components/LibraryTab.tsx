import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { getLibraryItems, deleteLibraryItem, saveLibraryItem, makeThumbnail, genId, type LibraryItem } from "../lib/library";
import { makeFilename } from "../types";
import Player from "./Player";
import Modal from "./Modal";

interface Props {
  fontSize: number;
  refreshKey: number;
  onEdit: (item: LibraryItem) => void;
}

const DEMO_ART = [
  "    .--------.    ",
  "   /  .    .  \\   ",
  "  | (o)    (o) |  ",
  "  |     --     |  ",
  "  |   \\____/   |  ",
  "   \\           /   ",
  "    '----------'    ",
].join("\n");

export default function LibraryTab({ fontSize, refreshKey, onEdit }: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    getLibraryItems()
      .then(result => { if (!cancelled) setItems(result); })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const load = async () => {
    try { setItems(await getLibraryItems()); } catch { setItems([]); }
  };

  const importImage = async (file: File): Promise<LibraryItem> => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    const W = 120, H = 50;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const chars = " .:-=+*#%@";
    const frame: number[][] = [], colorFrame: number[][][] = [];
    for (let y = 0; y < H; y++) {
      const row: number[] = [], cr: number[][] = [];
      for (let x = 0; x < W; x++) {
        const i = (y*W+x)*4;
        const lum = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
        row.push(Math.min(Math.floor(lum/256*chars.length), chars.length-1));
        cr.push([px[i], px[i+1], px[i+2]]);
      }
      frame.push(row); colorFrame.push(cr);
    }
    return {
      id: genId(), name: file.name, createdAt: Date.now(), source: "import", kind: "image",
      charset: chars, asciiW: W, asciiH: H, frameCount: 1,
      frames: [frame], colorFrames: [colorFrame],
      thumbnail: makeThumbnail([frame], chars, W, H),
    };
  };

  const importVideo = async (file: File): Promise<LibraryItem> => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url; video.muted = true;
    await new Promise<void>((res, rej) => { video.onloadedmetadata = () => res(); video.onerror = rej; });
    const W = 80, H = 30, fps = 10;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    const chars = " .:-=+*#%@";
    const frames: number[][][] = [], colorFrames: number[][][][] = [];
    const duration = video.duration;
    const frameCount = Math.min(Math.floor(duration * fps), 300);
    for (let fi = 0; fi < frameCount; fi++) {
      const t = (fi / frameCount) * duration;
      video.currentTime = t;
      await new Promise<void>(res => { video.onseeked = () => res(); });
      ctx.drawImage(video, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const frame: number[][] = [], colorFrame: number[][][] = [];
      for (let y = 0; y < H; y++) {
        const row: number[] = [], cr: number[][] = [];
        for (let x = 0; x < W; x++) {
          const i = (y*W+x)*4;
          const lum = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
          row.push(Math.min(Math.floor(lum/256*chars.length), chars.length-1));
          cr.push([px[i], px[i+1], px[i+2]]);
        }
        frame.push(row); colorFrame.push(cr);
      }
      frames.push(frame); colorFrames.push(colorFrame);
    }
    URL.revokeObjectURL(url);
    return {
      id: genId(), name: file.name, createdAt: Date.now(), source: "import", kind: "video",
      charset: chars, asciiW: W, asciiH: H, frameCount: frames.length,
      frames, colorFrames,
      thumbnail: makeThumbnail(frames, chars, W, H),
      fps,
    };
  };

  const importTxt = async (file: File): Promise<LibraryItem> => {
    const text = await file.text();
    const rawFrames = text.split(/\n---\n/);
    const chars = " .:-=+*#%@";
    const frames: number[][][] = rawFrames.map(raw => {
      return raw.split("\n").map(line =>
        Array.from(line).map(ch => Math.max(0, chars.indexOf(ch === "\u00a0" ? " " : ch)))
      );
    });
    const asciiW = Math.max(...frames.flatMap(f => f.map(r => r.length)));
    const asciiH = Math.max(...frames.map(f => f.length));
    return {
      id: genId(), name: file.name, createdAt: Date.now(), source: "import",
      kind: frames.length > 1 ? "video" : "image",
      charset: chars, asciiW, asciiH, frameCount: frames.length,
      frames,
      thumbnail: makeThumbnail(frames, chars, asciiW, asciiH),
    };
  };

  const handleImport = async (file: File) => {
    setError(null);
    setImporting(true);
    try {
      const name = file.name.toLowerCase();
      let item: LibraryItem;
      if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) item = await importImage(file);
      else if (/\.(mp4|webm|mov|avi)$/i.test(name)) item = await importVideo(file);
      else item = await importTxt(file);
      await saveLibraryItem(item);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = "";
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteLibraryItem(pendingDelete.id);
    if (selected?.id === pendingDelete.id) setSelected(null);
    setPendingDelete(null);
    await load();
  };

  if (!loaded) {
    return (
      <div className="tab-content">
        <div className="splash"><p className="splash-hint">Loading library…</p></div>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="toolbar">
        <div className="toolbar-left">
          {selected ? (
            <button className="btn btn-ghost" onClick={() => setSelected(null)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back</button>
          ) : (
            <span className="badge">{items.length} item{items.length !== 1 ? "s" : ""}</span>
          )}
          {error && <span className="badge badge-err"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> {error}</span>}
          {importing && <span className="badge">importing…</span>}
        </div>
        <div className="toolbar-right">
          {selected && (
            <>
              <button className="btn btn-ghost" onClick={() => { onEdit(selected); setSelected(null); }}>Edit</button>
              <button className="btn btn-danger btn-sm" onClick={() => setPendingDelete(selected)}>Delete</button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()} disabled={importing}>
            Import
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.mp4,.webm,.mov"
            style={{ display: "none" }}
            onChange={onFileChange}
          />
        </div>
      </div>

      <div className="library-layout">
        {selected ? (
          <div className="library-player">
            <Player item={selected} fontSize={fontSize} />
          </div>
        ) : items.length === 0 ? (
          <div className="splash">
            <pre className="library-demo-art">{DEMO_ART}</pre>
            <button className="btn btn-primary btn-lg" onClick={() => fileInputRef.current?.click()}>
              Import File
            </button>
            <p className="splash-hint">Import .txt · .png · .jpg · .gif · .webp · .mp4 · .webm</p>
            <p className="splash-hint">Recordings from Camera tab auto-save here</p>
          </div>
        ) : (
          <div className="library-grid">
            {items.map(item => (
              <div key={item.id} className="library-card" onClick={() => setSelected(item)}>
                <pre className="library-thumb">{item.thumbnail}</pre>
                <div className="library-card-info">
                  <span className="library-card-name">{item.name}</span>
                  <span className="library-card-meta">
                    {item.kind === "image" ? "Image" : `${item.frameCount}f`} · {item.asciiW}×{item.asciiH} · {item.source === "recording" ? "Recorded" : "Imported"}
                  </span>
                </div>
                <div className="library-card-actions" onClick={e => e.stopPropagation()}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setSelected(item)}>
                    {item.kind === "image" ? "View" : "Play"}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { onEdit(item); }}>Edit</button>
                  <button className="btn btn-danger btn-sm" title="Delete" onClick={() => setPendingDelete(item)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {pendingDelete && (
        <Modal
          title="Delete item"
          message={`Remove "${pendingDelete.name}" from your library?`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
