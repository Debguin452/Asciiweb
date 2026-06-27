export interface CapturedFrame {
  pixels: Uint8Array;
  width: number;
  height: number;
  timestamp: number;
}

export class FrameCapture {
  private video: HTMLVideoElement;
  private useVideoFrame: boolean;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;

    this.useVideoFrame = 'VideoFrame' in window &&
                         typeof (video as any).requestVideoFrameCallback === 'function';

    if (!this.useVideoFrame) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  async capture(): Promise<CapturedFrame | null> {
    if (this.video.readyState < 2) return null;

    const width = this.video.videoWidth;
    const height = this.video.videoHeight;

    if (!width || !height) return null;

    if (this.useVideoFrame) {
      return this.captureWithVideoFrame(width, height);
    } else {
      return this.captureWithCanvas(width, height);
    }
  }

  private async captureWithVideoFrame(width: number, height: number): Promise<CapturedFrame> {

    const frame = new (window as any).VideoFrame(this.video, {
      timestamp: performance.now() * 1000
    });

    try {
      const format = frame.format;
      const layout = frame.allocationLayout();

      const bytesNeeded = layout.totalBytes;
      const pixels = new Uint8Array(bytesNeeded);

      await frame.copyTo(pixels, {
        rect: { x: 0, y: 0, width, height },
        layout: [{ offset: 0, stride: width * 4 }]
      });

      return {
        pixels,
        width,
        height,
        timestamp: frame.timestamp
      };
    } finally {
      frame.close();
    }
  }

  private captureWithCanvas(width: number, height: number): CapturedFrame {

    const canvas = this.canvas!;
    const ctx = this.ctx!;

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    ctx.drawImage(this.video, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);

    return {
      pixels: new Uint8Array(imageData.data.buffer),
      width,
      height,
      timestamp: performance.now() * 1000
    };
  }

  get isAccelerated(): boolean {
    return this.useVideoFrame;
  }
}

export function getCaptureCapabilities(): {
  videoFrame: boolean;
  webCodecs: boolean;
  webgpu: boolean;
  sharedArrayBuffer: boolean;
} {
  return {
    videoFrame: 'VideoFrame' in window,
    webCodecs: 'VideoEncoder' in window,
    webgpu: 'gpu' in navigator,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined'
  };
}
