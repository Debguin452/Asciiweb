import type { AsciiFrame } from "./ascii";

export function frameToText(frame: AsciiFrame): string {
  return frame.map(row => row.map(c => c.char).join("")).join("\n");
}

export function framesToText(frames: AsciiFrame[]): string {
  return frames.map((f, i) => (i > 0 ? "\n---\n" : "") + frameToText(f)).join("");
}

export function frameToCanvas(frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean): HTMLCanvasElement {
  const cols = frame[0]?.length ?? 80;
  const rows = frame.length;
  const cw = Math.ceil(fontSize * 0.6);
  const ch = Math.ceil(fontSize * 1.15);
  const canvas = document.createElement("canvas");
  canvas.width = cols * cw;
  canvas.height = rows * ch;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
      const cell = frame[y][x];
      if (cell.char === " ") continue;
      ctx.fillStyle = color && (cell.r || cell.g || cell.b) ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
      ctx.fillText(cell.char, x * cw, (y + 1) * ch - Math.ceil(ch * 0.2));
    }
  }
  return canvas;
}

export function exportPng(frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean): Promise<Blob> {
  const canvas = frameToCanvas(frame, fontSize, fg, bg, color);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png");
  });
}

export function exportJpeg(frame: AsciiFrame, fontSize: number, fg: string, bg: string, color: boolean): Promise<Blob> {
  const canvas = frameToCanvas(frame, fontSize, fg, bg, color);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error("JPEG export failed")), "image/jpeg", 0.92);
  });
}

export async function exportGif(frames: AsciiFrame[], fontSize: number, fg: string, bg: string, color: boolean, fps: number): Promise<Blob> {
  const cols = frames[0]?.[0]?.length ?? 80;
  const rows = frames[0]?.length ?? 40;
  const cw = Math.ceil(fontSize * 0.6);
  const ch = Math.ceil(fontSize * 1.15);
  const W = cols * cw;
  const H = rows * ch;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const gif = GIFEncoder();
  const delay = Math.round(1000 / Math.max(1, fps));

  for (const frame of frames) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < frame.length; y++) {
      for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
        const cell = frame[y][x];
        if (cell.char === " ") continue;
        ctx.fillStyle = color && (cell.r || cell.g || cell.b) ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
        ctx.fillText(cell.char, x * cw, (y + 1) * ch - Math.ceil(ch * 0.2));
      }
    }
    const imgData = ctx.getImageData(0, 0, W, H);
    const palette = quantize(imgData.data, 256);
    const index = applyPalette(imgData.data, palette);
    gif.writeFrame(index, W, H, { palette, delay });
  }

  gif.finish();
  return new Blob([gif.bytesView()], { type: "image/gif" });
}

export async function exportMp4(frames: AsciiFrame[], fontSize: number, fg: string, bg: string, color: boolean, fps: number): Promise<Blob> {
  const cols = frames[0]?.[0]?.length ?? 80;
  const rows = frames[0]?.length ?? 40;
  const cw = Math.ceil(fontSize * 0.6);
  const ch = Math.ceil(fontSize * 1.15);
  const rawW = cols * cw;
  const rawH = rows * ch;
  const W = rawW % 2 === 0 ? rawW : rawW + 1;
  const H = rawH % 2 === 0 ? rawH : rawH + 1;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

  const drawFrame = (frame: AsciiFrame) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < frame.length; y++) {
      for (let x = 0; x < (frame[y]?.length ?? 0); x++) {
        const cell = frame[y][x];
        if (cell.char === " ") continue;
        ctx.fillStyle = color && (cell.r || cell.g || cell.b) ? `rgb(${cell.r},${cell.g},${cell.b})` : fg;
        ctx.fillText(cell.char, x * cw, (y + 1) * ch - Math.ceil(ch * 0.2));
      }
    }
  };

  if (typeof VideoEncoder !== "undefined") {
    const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: console.error,
    });
    encoder.configure({ codec: "avc1.42001f", width: W, height: H, bitrate: 2_000_000, framerate: fps });
    const dur = Math.round(1_000_000 / fps);
    for (let i = 0; i < frames.length; i++) {
      drawFrame(frames[i]);
      const vf = new VideoFrame(canvas, { timestamp: i * dur, duration: dur });
      encoder.encode(vf, { keyFrame: i % 30 === 0 });
      vf.close();
    }
    await encoder.flush();
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  }

  return new Promise((resolve, reject) => {
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    recorder.onerror = reject;
    recorder.start();
    let i = 0;
    const interval = 1000 / Math.max(1, fps);
    const tick = () => {
      if (i >= frames.length) { recorder.stop(); return; }
      drawFrame(frames[i++]);
      setTimeout(tick, interval);
    };
    tick();
  });
}
