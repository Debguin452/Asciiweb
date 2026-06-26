// WebGL Renderer - GPU-accelerated ASCII rendering
// 5-20x faster than Canvas2D for large frames

export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private glyphAtlas: HTMLCanvasElement | null = null;
  private glyphTexture: WebGLTexture | null = null;
  
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initWebGL();
  }
  
  private initWebGL() {
    try {
      this.gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: false
      });
      
      if (!this.gl) {
        console.warn('[WebGLRenderer] WebGL2 not available');
        return;
      }
      
      this.createShaderProgram();
      this.createTextures();
    } catch (err) {
      console.warn('[WebGLRenderer] Init failed:', err);
      this.gl = null;
    }
  }
  
  private createShaderProgram() {
    const gl = this.gl!;
    
    // Vertex shader
    const vsSource = `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;
      
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `;
    
    // Fragment shader - renders ASCII from glyph atlas
    const fsSource = `
      precision mediump float;
      varying vec2 v_texCoord;
      uniform sampler2D u_glyphAtlas;
      uniform sampler2D u_charMap;
      uniform vec2 u_atlasSize;
      uniform vec2 u_cellSize;
      uniform vec2 u_gridSize;
      
      void main() {
        // Determine which cell we're in
        vec2 cell = floor(v_texCoord * u_gridSize);
        vec2 cellCoord = fract(v_texCoord * u_gridSize);
        
        // Sample character index from char map
        vec2 charMapCoord = (cell + 0.5) / u_gridSize;
        float charIdx = texture2D(u_charMap, charMapCoord).r * 255.0;
        
        // Calculate atlas position
        float col = mod(charIdx, 16.0);
        float row = floor(charIdx / 16.0);
        vec2 atlasCoord = (vec2(col, row) * u_cellSize + cellCoord * u_cellSize) / u_atlasSize;
        
        // Sample glyph
        vec4 color = texture2D(u_glyphAtlas, atlasCoord);
        gl_FragColor = color;
      }
    `;
    
    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    
    // Link program
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('[WebGLRenderer] Shader link failed:', gl.getProgramInfoLog(this.program));
      return;
    }
    
    gl.useProgram(this.program);
  }
  
  private createTextures() {
    const gl = this.gl!;
    
    // Glyph atlas texture
    this.glyphTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    // Character map texture (stores char indices)
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  
  loadGlyphAtlas(atlas: HTMLCanvasElement) {
    const gl = this.gl!;
    this.glyphAtlas = atlas;
    
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  }
  
  render(charIndices: Uint8Array, width: number, height: number, cellWidth: number, cellHeight: number) {
    const gl = this.gl!;
    if (!this.program || !this.glyphAtlas) return;
    
    // Resize canvas
    this.canvas.width = width * cellWidth;
    this.canvas.height = height * cellHeight;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    
    // Update character map texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.LUMINANCE,
      width, height, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE,
      charIndices
    );
    
    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_atlasSize'), this.glyphAtlas.width, this.glyphAtlas.height);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_cellSize'), cellWidth, cellHeight);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_gridSize'), width, height);
    
    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.glyphTexture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_glyphAtlas'), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_charMap'), 1);
    
    // Draw fullscreen quad
    const positions = new Float32Array([
      -1, -1,  0, 1,
       1, -1,  1, 1,
      -1,  1,  0, 0,
       1,  1,  1, 0
    ]);
    
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    const texLoc = gl.getAttribLocation(this.program, 'a_texCoord');
    
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
    
    gl.enableVertexAttribArray(texLoc);
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 16, 8);
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.deleteBuffer(buffer);
  }
  
  get isAvailable(): boolean {
    return this.gl !== null && this.program !== null;
  }
  
  destroy() {
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.texture) this.gl.deleteTexture(this.texture);
      if (this.glyphTexture) this.gl.deleteTexture(this.glyphTexture);
    }
  }
}
