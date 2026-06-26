// Worker Manager - Handles OffscreenCanvas workers with fallback

export class WorkerManager {
  private worker: Worker | null = null;
  private ready = false;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 0;
  private useWorker = false;
  
  constructor() {
    this.initWorker();
  }
  
  private async initWorker() {
    try {
      // Check if OffscreenCanvas is supported
      if (typeof OffscreenCanvas === 'undefined') {
        console.log('[WorkerManager] OffscreenCanvas not supported, using main thread');
        return;
      }
      
      // Create worker
      this.worker = new Worker(
        new URL('./ascii.worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      // Wait for ready message
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Worker init timeout'));
        }, 5000);
        
        this.worker!.onmessage = (e) => {
          if (e.data.type === 'ready') {
            clearTimeout(timeout);
            this.ready = true;
            this.useWorker = true;
            console.log('[WorkerManager] ✅ Worker ready');
            resolve();
          } else if (e.data.type === 'result') {
            const { id, frame, error, success } = e.data;
            const pending = this.pendingRequests.get(id);
            if (pending) {
              this.pendingRequests.delete(id);
              if (success) {
                pending.resolve(frame);
              } else {
                pending.reject(new Error(error));
              }
            }
          }
        };
        
        this.worker!.onerror = (err) => {
          clearTimeout(timeout);
          console.warn('[WorkerManager] Worker error:', err);
          reject(err);
        };
      });
    } catch (err) {
      console.warn('[WorkerManager] Failed to init worker, using main thread:', err);
      this.useWorker = false;
    }
  }
  
  async processFrame(
    imageData: Uint8ClampedArray,
    width: number,
    height: number,
    opts: any,
    mirror: boolean
  ): Promise<any> {
    if (!this.useWorker || !this.worker) {
      // Fallback to main thread
      const { processFrame } = await import('./ascii');
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas context failed');
      
      ctx.putImageData(new ImageData(imageData, width, height), 0, 0);
      
      const fakeVideo = {
        videoWidth: width,
        videoHeight: height,
        readyState: 2
      } as any;
      
      return processFrame(fakeVideo, canvas, opts, mirror);
    }
    
    // Send to worker
    const id = this.nextId++;
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      this.worker!.postMessage({
        type: 'process',
        id,
        data: {
          imageData: imageData.buffer,
          width,
          height,
          opts,
          mirror
        }
      }, [imageData.buffer]); // Transfer buffer (zero-copy)
    });
  }
  
  get isUsingWorker(): boolean {
    return this.useWorker;
  }
  
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

// Singleton instance
export const workerManager = new WorkerManager();
