import { hexToRgb01, isWhitePigment } from "./pigments";

export type BrushShape = "round" | "filbert" | "square";
export type HairType = "sable" | "hog";

export type WatercolorParams = {
  backgroundColor: string;
  brushHairType: HairType;
  brushShape: BrushShape;
  brushSize: number;
  dryingSpeed: number;
  edgeDarkening: number;
  granulation: number;
  includeBackground: boolean;
  pigmentHex: string;
  pigmentOpacity: number;
  reliefHeight: number;
  roughness: number;
  wetnessSpread: number;
};

// Multiply/fract-based hash: avoids sin()/trig, which is comparatively
// expensive on both mobile GPUs and software (SwiftShader-class) renderers.
const NOISE_GLSL = `
float toolcraftHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float toolcraftNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = toolcraftHash(i);
  float b = toolcraftHash(i + vec2(1.0, 0.0));
  float c = toolcraftHash(i + vec2(0.0, 1.0));
  float d = toolcraftHash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}
`;

// Only needed where the paper heightmap is actually computed from noise (the
// precomputed paper-height pass below); the simulation/composite passes
// instead sample the cached uPaperHeight texture.
const PAPER_HEIGHT_GLSL = `
float toolcraftPaperHeight(vec2 uv, float roughness, float relief, vec2 resolution) {
  float aspect = resolution.x / max(resolution.y, 1.0);
  float freq = mix(6.0, 46.0, roughness);
  vec2 p = vec2(uv.x * aspect, uv.y);
  float n = toolcraftNoise(p * freq);
  n += 0.5 * toolcraftNoise(p * freq * 2.07 + 11.0);
  n /= 1.5;
  return n * mix(0.15, 1.0, relief);
}
`;

const VERTEX_SHADER_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// Paper height only depends on roughness/relief/resolution, not on the live
// simulation state, so it is precomputed once into a texture instead of being
// recomputed from noise on every animation frame in both the simulation and
// composite passes.
const PAPER_HEIGHT_FRAGMENT_SHADER_SOURCE = `
precision highp float;
varying vec2 vUv;

uniform vec2 uResolution;
uniform float uRoughness;
uniform float uReliefHeight;

${NOISE_GLSL}
${PAPER_HEIGHT_GLSL}

void main() {
  float height = toolcraftPaperHeight(vUv, uRoughness, uReliefHeight, uResolution);
  gl_FragColor = vec4(height, height, height, 1.0);
}
`;

const SIMULATION_FRAGMENT_SHADER_SOURCE = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uPrev;
uniform sampler2D uPaperHeight;
uniform vec2 uTexel;
uniform vec2 uResolution;
uniform float uDt;

uniform float uWetnessSpread;
uniform float uGranulation;
uniform float uEdgeDarkening;
uniform float uPigmentOpacity;
uniform float uDryingSpeed;

uniform bool uBrushActive;
uniform vec2 uBrushPos;
uniform vec2 uBrushPrevPos;
uniform float uBrushRadius;
uniform int uBrushShape;
uniform float uBrushHairNoise;
uniform float uBrushCharge;
uniform vec3 uDepositColor;
uniform bool uDepositIsWhite;

${NOISE_GLSL}

float toolcraftDistToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec4 current = texture2D(uPrev, vUv);
  vec3 absorption = current.rgb;
  float wetness = current.a;

  if (uBrushActive && uBrushCharge > 0.001) {
    float d = toolcraftDistToSegment(vUv, uBrushPrevPos, uBrushPos);

    if (uBrushShape == 2) {
      vec2 rel = vUv - uBrushPos;
      d = min(d, max(abs(rel.x) * uResolution.x, abs(rel.y) * uResolution.y) / uResolution.x);
    }

    float shapeRadius = uBrushShape == 1 ? uBrushRadius * 0.82 : uBrushRadius;
    float hairJitter =
      (toolcraftNoise(vUv * uResolution * 0.75) - 0.5) * uBrushHairNoise * shapeRadius;
    float mask = 1.0 - smoothstep(shapeRadius * 0.55, shapeRadius + hairJitter, d);
    mask = clamp(mask, 0.0, 1.0) * uBrushCharge;

    if (mask > 0.0) {
      wetness = clamp(wetness + mask, 0.0, 1.0);
      float strength = mask * mix(0.12, 0.85, uPigmentOpacity);

      if (uDepositIsWhite) {
        absorption = mix(absorption, vec3(0.0), strength);
      } else {
        absorption = absorption + (uDepositColor - absorption) * strength;
      }
    }
  }

  vec4 sN = texture2D(uPrev, vUv + vec2(0.0, uTexel.y));
  vec4 sS = texture2D(uPrev, vUv - vec2(0.0, uTexel.y));
  vec4 sE = texture2D(uPrev, vUv + vec2(uTexel.x, 0.0));
  vec4 sW = texture2D(uPrev, vUv - vec2(uTexel.x, 0.0));

  vec3 neighborAbsorption = (sN.rgb + sS.rgb + sE.rgb + sW.rgb) * 0.25;
  float neighborWetness = (sN.a + sS.a + sE.a + sW.a) * 0.25;
  float diffuseAmount = clamp(uWetnessSpread * 0.6 * wetness, 0.0, 0.5);
  absorption = mix(absorption, neighborAbsorption, diffuseAmount);
  wetness = mix(wetness, neighborWetness, diffuseAmount * 0.5);

  float height = texture2D(uPaperHeight, vUv).r;
  float granulationTerm = uGranulation * wetness * (0.5 - height);
  absorption = clamp(absorption + granulationTerm * 0.18, 0.0, 1.0);

  float wetGrad = abs(sN.a - sS.a) + abs(sE.a - sW.a);
  float edge =
    uEdgeDarkening * wetGrad * smoothstep(0.05, 0.35, wetness) *
    (1.0 - smoothstep(0.4, 0.9, wetness));
  absorption = clamp(absorption + edge * 0.45, 0.0, 1.0);

  float dryRate = mix(0.05, 2.4, uDryingSpeed) * uDt;
  wetness = clamp(wetness - dryRate, 0.0, 1.0);

  gl_FragColor = vec4(absorption, wetness);
}
`;

// uBackgroundColor is the user-facing paper tint (appearance.background); uIncludeBackground
// toggles whether the product-rendered paper background is composited at all (export.includeBackground).
// When it is false, only the painted pigment ink remains, with alpha equal to pigment coverage, so
// live preview reveals the runtime canvas shell/backing and PNG export produces a transparent paper.
const COMPOSITE_FRAGMENT_SHADER_SOURCE = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uState;
uniform sampler2D uPaperHeight;
uniform vec3 uBackgroundColor;
uniform bool uIncludeBackground;

void main() {
  vec4 state = texture2D(uState, vUv);
  vec3 absorption = state.rgb;
  float height = texture2D(uPaperHeight, vUv).r;

  if (uIncludeBackground) {
    vec3 lightPaper = clamp(uBackgroundColor + vec3(0.06, 0.07, 0.10), 0.0, 1.0);
    vec3 paperColor = mix(uBackgroundColor, lightPaper, height);
    vec3 color = paperColor * (1.0 - clamp(absorption, 0.0, 1.0) * 0.88);
    color += state.a * 0.04;
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  } else {
    float coverage = clamp(max(absorption.r, max(absorption.g, absorption.b)) * 1.15, 0.0, 1.0);
    vec3 inkColor = vec3(1.0) * (1.0 - clamp(absorption, 0.0, 1.0) * 0.92) + state.a * 0.04;
    gl_FragColor = vec4(clamp(inkColor, 0.0, 1.0), coverage);
  }
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error("Toolcraft watercolour renderer could not create a shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Toolcraft watercolour shader failed to compile: ${info ?? "unknown error"}`);
  }

  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram();

  if (!program) {
    throw new Error("Toolcraft watercolour renderer could not create a program.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Toolcraft watercolour program failed to link: ${info ?? "unknown error"}`);
  }

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  return program;
}

function createPaperHeightTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();

  if (!texture) {
    throw new Error("Toolcraft watercolour renderer could not create a texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

function createStateTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();

  if (!texture) {
    throw new Error("Toolcraft watercolour renderer could not create a texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array(width * height * 4),
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return texture;
}

function createFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();

  if (!framebuffer) {
    throw new Error("Toolcraft watercolour renderer could not create a framebuffer.");
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return framebuffer;
}

type PingPongTarget = {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
};

const brushShapeCode: Record<BrushShape, number> = {
  filbert: 1,
  round: 0,
  square: 2,
};

export class WatercolorEngine {
  private gl: WebGL2RenderingContext;

  private quadBuffer: WebGLBuffer;

  private simulationProgram: WebGLProgram;

  private compositeProgram: WebGLProgram;

  private paperProgram: WebGLProgram;

  private paperHeightTexture: WebGLTexture;

  private paperHeightFramebuffer: WebGLFramebuffer;

  private paperRoughness: number;

  private paperReliefHeight: number;

  private targets: [PingPongTarget, PingPongTarget];

  private readIndex = 0;

  private width = 0;

  private height = 0;

  private params: WatercolorParams;

  private brushActive = false;

  private brushPos: [number, number] = [0, 0];

  private brushPrevPos: [number, number] = [0, 0];

  private brushCharge = 1;

  private lastFrameTime = 0;

  private rafHandle: number | null = null;

  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    initialParams: WatercolorParams,
  ) {
    if (!document.createElement("canvas").getContext("webgl2")) {
      throw new Error("Toolcraft watercolour renderer requires WebGL2 support.");
    }

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      // Required so external code (browser tests, screenshots) can read the live canvas via
      // drawImage/getImageData at an arbitrary time; without it the backbuffer can be cleared
      // between our own draw calls and an external read.
      preserveDrawingBuffer: true,
    });

    if (!gl) {
      throw new Error("Toolcraft watercolour renderer requires WebGL2.");
    }

    this.gl = gl;
    this.params = initialParams;

    const quadBuffer = gl.createBuffer();

    if (!quadBuffer) {
      throw new Error("Toolcraft watercolour renderer could not create a vertex buffer.");
    }

    this.quadBuffer = quadBuffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.simulationProgram = createProgram(
      gl,
      VERTEX_SHADER_SOURCE,
      SIMULATION_FRAGMENT_SHADER_SOURCE,
    );
    this.compositeProgram = createProgram(
      gl,
      VERTEX_SHADER_SOURCE,
      COMPOSITE_FRAGMENT_SHADER_SOURCE,
    );
    this.paperProgram = createProgram(
      gl,
      VERTEX_SHADER_SOURCE,
      PAPER_HEIGHT_FRAGMENT_SHADER_SOURCE,
    );

    this.targets = this.createTargets(width, height);
    this.width = width;
    this.height = height;

    this.paperHeightTexture = createPaperHeightTexture(gl, width, height);
    this.paperHeightFramebuffer = createFramebuffer(gl, this.paperHeightTexture);
    this.paperRoughness = initialParams.roughness;
    this.paperReliefHeight = initialParams.reliefHeight;
    this.renderPaperHeight();

    this.lastFrameTime = performance.now();
    this.tick();
  }

  /** Recomputes the cached paper heightmap texture. Only roughness/reliefHeight/size affect it. */
  private renderPaperHeight(): void {
    const gl = this.gl;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.paperHeightFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.paperProgram);
    this.bindQuad(this.paperProgram);

    gl.uniform2f(gl.getUniformLocation(this.paperProgram, "uResolution"), this.width, this.height);
    gl.uniform1f(gl.getUniformLocation(this.paperProgram, "uRoughness"), this.paperRoughness);
    gl.uniform1f(
      gl.getUniformLocation(this.paperProgram, "uReliefHeight"),
      this.paperReliefHeight,
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private createTargets(width: number, height: number): [PingPongTarget, PingPongTarget] {
    const gl = this.gl;
    const makeTarget = (): PingPongTarget => {
      const texture = createStateTexture(gl, width, height);
      const framebuffer = createFramebuffer(gl, texture);
      return { framebuffer, texture };
    };

    return [makeTarget(), makeTarget()];
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      return;
    }

    if (width === this.width && height === this.height) {
      return;
    }

    const gl = this.gl;
    gl.deleteFramebuffer(this.targets[0].framebuffer);
    gl.deleteFramebuffer(this.targets[1].framebuffer);
    gl.deleteTexture(this.targets[0].texture);
    gl.deleteTexture(this.targets[1].texture);
    gl.deleteFramebuffer(this.paperHeightFramebuffer);
    gl.deleteTexture(this.paperHeightTexture);

    this.targets = this.createTargets(width, height);
    this.width = width;
    this.height = height;
    this.readIndex = 0;

    this.paperHeightTexture = createPaperHeightTexture(gl, width, height);
    this.paperHeightFramebuffer = createFramebuffer(gl, this.paperHeightTexture);
    this.renderPaperHeight();
  }

  setParams(params: WatercolorParams): void {
    this.params = params;

    if (params.roughness !== this.paperRoughness || params.reliefHeight !== this.paperReliefHeight) {
      this.paperRoughness = params.roughness;
      this.paperReliefHeight = params.reliefHeight;
      this.renderPaperHeight();
    }
  }

  setBrushCharge(charge: number): void {
    this.brushCharge = Math.max(0, Math.min(1, charge));
  }

  getBrushCharge(): number {
    return this.brushCharge;
  }

  beginStroke(uvX: number, uvY: number): void {
    this.brushPos = [uvX, uvY];
    this.brushPrevPos = [uvX, uvY];
    this.brushActive = true;
  }

  moveStroke(uvX: number, uvY: number): void {
    this.brushPos = [uvX, uvY];
    this.brushActive = true;
  }

  endStroke(): void {
    this.brushActive = false;
  }

  clear(): void {
    const gl = this.gl;

    for (const target of this.targets) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drawSimulationStep(dt: number): void {
    const gl = this.gl;
    const readTarget = this.targets[this.readIndex];
    const writeTarget = this.targets[this.readIndex === 0 ? 1 : 0];

    gl.bindFramebuffer(gl.FRAMEBUFFER, writeTarget.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.simulationProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readTarget.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paperHeightTexture);

    const program = this.simulationProgram;
    this.bindQuad(program);

    gl.uniform1i(gl.getUniformLocation(program, "uPrev"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uPaperHeight"), 1);
    gl.uniform2f(gl.getUniformLocation(program, "uTexel"), 1 / this.width, 1 / this.height);
    gl.uniform2f(gl.getUniformLocation(program, "uResolution"), this.width, this.height);
    gl.uniform1f(gl.getUniformLocation(program, "uDt"), dt);

    gl.uniform1f(gl.getUniformLocation(program, "uWetnessSpread"), this.params.wetnessSpread);
    gl.uniform1f(gl.getUniformLocation(program, "uGranulation"), this.params.granulation);
    gl.uniform1f(gl.getUniformLocation(program, "uEdgeDarkening"), this.params.edgeDarkening);
    gl.uniform1f(gl.getUniformLocation(program, "uPigmentOpacity"), this.params.pigmentOpacity);
    gl.uniform1f(gl.getUniformLocation(program, "uDryingSpeed"), this.params.dryingSpeed);

    gl.uniform1i(gl.getUniformLocation(program, "uBrushActive"), this.brushActive ? 1 : 0);
    gl.uniform2f(gl.getUniformLocation(program, "uBrushPos"), this.brushPos[0], this.brushPos[1]);
    gl.uniform2f(
      gl.getUniformLocation(program, "uBrushPrevPos"),
      this.brushPrevPos[0],
      this.brushPrevPos[1],
    );
    const brushRadiusUv = Math.max(0.002, (this.params.brushSize / 10) * 0.05 + 0.006);
    gl.uniform1f(gl.getUniformLocation(program, "uBrushRadius"), brushRadiusUv);
    gl.uniform1i(gl.getUniformLocation(program, "uBrushShape"), brushShapeCode[this.params.brushShape]);
    gl.uniform1f(
      gl.getUniformLocation(program, "uBrushHairNoise"),
      this.params.brushHairType === "hog" ? 0.75 : 0.12,
    );
    gl.uniform1f(gl.getUniformLocation(program, "uBrushCharge"), this.brushCharge);

    // uDepositColor is a subtractive-absorption color: how strongly each channel is
    // absorbed (removed) by this pigment, i.e. the complement of its visible hue.
    const [r, g, b] = hexToRgb01(this.params.pigmentHex);
    gl.uniform3f(gl.getUniformLocation(program, "uDepositColor"), 1 - r, 1 - g, 1 - b);
    gl.uniform1i(
      gl.getUniformLocation(program, "uDepositIsWhite"),
      isWhitePigment(this.params.pigmentHex) ? 1 : 0,
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.brushPrevPos = this.brushPos;
    this.readIndex = this.readIndex === 0 ? 1 : 0;
  }

  private drawComposite(target: WebGLFramebuffer | null, width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.compositeProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.readIndex].texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paperHeightTexture);

    const program = this.compositeProgram;
    this.bindQuad(program);

    gl.uniform1i(gl.getUniformLocation(program, "uState"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uPaperHeight"), 1);

    const [bgR, bgG, bgB] = hexToRgb01(this.params.backgroundColor);
    gl.uniform3f(gl.getUniformLocation(program, "uBackgroundColor"), bgR, bgG, bgB);
    gl.uniform1i(
      gl.getUniformLocation(program, "uIncludeBackground"),
      this.params.includeBackground ? 1 : 0,
    );

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindQuad(program: WebGLProgram): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const location = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
  }

  private tick = (): void => {
    if (this.destroyed) {
      return;
    }

    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    this.drawSimulationStep(dt);
    this.drawComposite(null, this.width, this.height);

    this.rafHandle = requestAnimationFrame(this.tick);
  };

  /** Returns the current painted state as a 2D canvas at simulation backing resolution, for export compositing. */
  getCompositeCanvas(): HTMLCanvasElement {
    const gl = this.gl;

    this.drawComposite(null, this.width, this.height);

    const pixels = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = this.width;
    sourceCanvas.height = this.height;
    const sourceContext = sourceCanvas.getContext("2d");

    if (!sourceContext) {
      throw new Error("Toolcraft watercolour export requires a 2D canvas context.");
    }

    const imageData = sourceContext.createImageData(this.width, this.height);

    for (let y = 0; y < this.height; y += 1) {
      const srcRowStart = (this.height - 1 - y) * this.width * 4;
      const dstRowStart = y * this.width * 4;
      imageData.data.set(
        pixels.subarray(srcRowStart, srcRowStart + this.width * 4),
        dstRowStart,
      );
    }

    sourceContext.putImageData(imageData, 0, 0);

    return sourceCanvas;
  }

  destroy(): void {
    this.destroyed = true;

    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
    }

    const gl = this.gl;
    gl.deleteFramebuffer(this.targets[0].framebuffer);
    gl.deleteFramebuffer(this.targets[1].framebuffer);
    gl.deleteTexture(this.targets[0].texture);
    gl.deleteTexture(this.targets[1].texture);
    gl.deleteFramebuffer(this.paperHeightFramebuffer);
    gl.deleteTexture(this.paperHeightTexture);
    gl.deleteProgram(this.simulationProgram);
    gl.deleteProgram(this.compositeProgram);
    gl.deleteProgram(this.paperProgram);
    gl.deleteBuffer(this.quadBuffer);
  }
}
