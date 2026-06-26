// Quick test to see if WASM loads
import('./src/lib/wasm-pkg/asciiweb_wasm.js')
  .then(wasm => {
    console.log('✅ WASM loaded!');
    console.log('Functions:', Object.keys(wasm));
    console.log('Has adjust_image:', typeof wasm.adjust_image);
    console.log('Has sobel_edge:', typeof wasm.sobel_edge);
  })
  .catch(err => {
    console.error('❌ WASM failed:', err);
  });
