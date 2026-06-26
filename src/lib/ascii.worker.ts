// Web Worker for ASCII processing
// Runs on separate thread, doesn't block UI

import { processFrame, type AsciiOptions, type AsciiFrame } from './ascii';

// Offscreen canvas for processing
const offscreen = new OffscreenCanvas(1, 1);

// Message handler
self.onmessage = async (e: MessageEvent) => {
  const { type, id, data } = e.data;
  
  if (type === 'process') {
    try {
      const { imageData, width, height, opts, mirror } = data;
      
      // Create ImageBitmap from data
      const bitmap = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(imageData), width, height)
      );
      
      // Create video-like object for processFrame
      const fakeVideo = {
        videoWidth: width,
        videoHeight: height,
        readyState: 2,
        play: () => Promise.resolve(),
        pause: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
      } as any;
      
      // Draw bitmap to offscreen canvas
      offscreen.width = width;
      offscreen.height = height;
      const ctx = offscreen.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        
        // Process frame
        const frame = processFrame(fakeVideo, offscreen as any, opts, mirror);
        
        // Send result back
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

// Signal ready
self.postMessage({ type: 'ready' });
