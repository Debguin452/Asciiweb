export interface EncodeJob { force: boolean; budget: number; pixel: boolean }

export interface CaptureParams {
  w: number;
  h: number;
  mirror: boolean;
  lowLight: boolean;
  encode: EncodeJob | null;
}

export interface CaptureResult {
  w: number;
  h: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  packet: ArrayBuffer | null;
}

interface Pending {
  id: number;
  startedAt: number;
  resolve: (r: CaptureResult | null) => void;
}

const STALL_MS = 2000;

export class CapturePipeline {
  onFail: (() => void) | null = null;
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private seq = 0;
  private dead = false;

  get usable(): boolean {
    return !this.dead
      && typeof Worker !== "undefined"
      && typeof OffscreenCanvas !== "undefined"
      && typeof createImageBitmap === "function";
  }

  get busy(): boolean {
    if (this.pending && performance.now() - this.pending.startedAt > STALL_MS) this.fail();
    return this.pending !== null;
  }

  submit(video: HTMLVideoElement, params: CaptureParams): Promise<CaptureResult | null> {
    const worker = this.ensure();
    if (!worker || this.pending) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise(resolve => {
      this.pending = { id, startedAt: performance.now(), resolve };
      createImageBitmap(video).then(bmp => {
        if (this.pending?.id !== id) { bmp.close(); return; }
        worker.postMessage({ type: "frame", id, bmp, ...params }, [bmp]);
      }).catch(() => this.fail());
    });
  }

  resetLight() { this.worker?.postMessage({ type: "resetLight" }); }

  resetEncoder() { this.worker?.postMessage({ type: "resetEncoder" }); }

  dispose() {
    this.pending?.resolve(null);
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (!this.usable) return null;
    try {
      const worker = new Worker(new URL("./capture.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = e => this.receive(e.data);
      worker.onerror = () => this.fail();
      worker.onmessageerror = () => this.fail();
      this.worker = worker;
    } catch {
      this.dead = true;
    }
    return this.worker;
  }

  private receive(m: { type: string; id: number; w: number; h: number; rgba: ArrayBuffer; packet: ArrayBuffer | null }) {
    if (m.type === "error") { this.fail(); return; }
    const p = this.pending;
    if (!p || p.id !== m.id) return;
    this.pending = null;
    p.resolve({ w: m.w, h: m.h, rgba: new Uint8ClampedArray(m.rgba), packet: m.packet });
  }

  private fail() {
    if (this.dead) return;
    this.dead = true;
    const p = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    p?.resolve(null);
    this.onFail?.();
  }
}
