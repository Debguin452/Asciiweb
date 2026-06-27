import { processFrame, type AsciiOptions, type AsciiFrame } from './ascii';

const offscreen = new OffscreenCanvas(1, 1);

self.onmessage = async (e: MessageEvent) => {
  const { type, id, data } = e.data;

  if (type === 'process') {
    try {
      const { imageData, width, height, opts, mirror } = data;

      const bitmap = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(imageData), width, height)
      );

      const fakeVideo = {
        videoWidth: width,
        videoHeight: height,
        readyState: 2,
        play: () => Promise.resolve(),
        pause: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      } as any;

      offscreen.width = width;
      offscreen.height = height;
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();

        const frame = processFrame(fakeVideo, offscreen as any, opts, mirror);

        self.postMessage({
          type: 'result',
          id,
          frame,
          success: true
        });
      }
    } catch (err) {
      self.postMessage({
        type: 'result',
        id,
        error: err instanceof Error ? err.message : 'Unknown error',
        success: false
      });
    }
  }
};

self.postMessage({ type: 'ready' });
