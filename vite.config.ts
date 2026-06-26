import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
    optimizeDeps: {
      exclude: ['asciiweb_wasm', './src/lib/wasm-pkg']
    },
    assetsInclude: ['**/*.wasm'],
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    },
  build: {
    target: 'esnext',
  },
});
