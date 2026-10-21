import { LowLightAssist } from "./denoise";
import { AdaptiveEncoder } from "./adaptive";

interface EncodeJob { force: boolean; budget: number; pixel: boolean }

type Incoming =
  | { type: "frame"; id: number; bmp: ImageBitmap; w: number; h: number; mirror: boolean; lowLight: boolean; encode: EncodeJob | null }
  | { type: "resetLight" }
  | { type: "resetEncoder" };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Incoming>) => void) | null;
};

const light = new LowLightAssist();
const encoder = new AdaptiveEncoder();
let canvas: OffscreenCanvas | null = null;

scope.onmessage = e => {
  const m = e.data;
  if (m.type === "resetLight") { light.reset(); return; }
  if (m.type === "resetEncoder") { encoder.reset(); return; }

  try {
    const { w, h, bmp } = m;
    if (!canvas) canvas = new OffscreenCanvas(w, h);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.save();
    if (m.mirror) { ctx.scale(-1, 1); ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, -w, 0, w, h); }
    else ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, w, h);
    ctx.restore();
    bmp.close();

    const img = ctx.getImageData(0, 0, w, h);
    if (m.lowLight) light.process(img.data, w, h);

    const packet = m.encode ? encoder.encode(img.data, w, h, m.encode.budget, m.encode.force, { pixel: m.encode.pixel }) : null;
    const transfer: Transferable[] = [img.data.buffer];
    if (packet) transfer.push(packet);
    scope.postMessage({ type: "frame", id: m.id, w, h, rgba: img.data.buffer, packet }, transfer);
  } catch {
    scope.postMessage({ type: "error", id: m.type === "frame" ? m.id : 0 });
  }
};
