#!/bin/bash
set -e

echo "Building AsciiWeb WASM module..."

if ! command -v wasm-pack &> /dev/null; then
    echo "Error: wasm-pack not found. Install with: cargo install wasm-pack"
    exit 1
fi

echo "Compiling Rust to WebAssembly..."
wasm-pack build --target web --release --out-dir pkg

echo "Build complete!"
echo "Output: ./pkg/"
echo ""
echo "Next steps:"
echo "1. Copy pkg/ to src/lib/wasm-pkg/ in your AsciiWeb project"
echo "2. Copy wasm-wrapper.ts to src/lib/"
echo "3. Update vite.config.ts and package.json"
