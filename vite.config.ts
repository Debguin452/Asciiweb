import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    hmr: {
      clientPort: 5173,
      host: 'localhost',
      protocol: 'ws'
    }
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
  publicDir: 'public',
});
