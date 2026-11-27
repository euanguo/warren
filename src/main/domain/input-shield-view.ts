export type ShieldMode = 'agent' | 'idle';
export type ShieldTheme = 'dark' | 'light';

export interface ShieldVisualAction {
  kind: 'click' | 'fill' | 'hover' | 'move';
  x: number;
  y: number;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
}

export interface ShieldAnimationInput {
  attached: boolean;
  visible: boolean;
  mode: ShieldMode;
  reducedMotion: boolean;
  hidden?: boolean;
}

/** 仅当遮罩挂载、窗口/舞台可见、处于 Agent 控制态且系统未开启减弱动画时驱动 WebGL rAF 循环。 */
export function shouldShieldAnimate(input: ShieldAnimationInput): boolean {
  return Boolean(input.attached && input.visible && input.mode === 'agent' && !input.reducedMotion && !input.hidden);
}

export const SHIELD_PALETTES: Record<
  ShieldTheme,
  {
    colorA: [number, number, number, number];
    colorB: [number, number, number, number];
    colorC: [number, number, number, number];
    veilIntensity: number;
    dotColor: [number, number, number];
    dotOpacity: number;
    sparkColor: [number, number, number];
    sparkOpacity: number;
    borderAccent: [number, number, number];
    borderStroke: number;
    borderBlur: number;
    borderFade: number;
  }
> = {
  dark: {
    colorA: [0.36, 0.56, 1.0, 0.08],
    colorB: [0.22, 0.48, 0.98, 0.16],
    colorC: [0.22, 0.74, 0.97, 0.07],
    veilIntensity: 0.84,
    dotColor: [0.42, 0.66, 1.0],
    dotOpacity: 0.22,
    sparkColor: [0.58, 0.86, 1.0],
    sparkOpacity: 0.76,
    borderAccent: [0.36, 0.55, 1.0],
    borderStroke: 2.2,
    borderBlur: 13.0,
    borderFade: 0.95,
  },
  light: {
    colorA: [0.24, 0.46, 0.96, 0.07],
    colorB: [0.16, 0.38, 0.9, 0.13],
    colorC: [0.06, 0.56, 0.86, 0.06],
    veilIntensity: 0.9,
    dotColor: [0.22, 0.42, 0.92],
    dotOpacity: 0.18,
    sparkColor: [0.18, 0.52, 0.98],
    sparkOpacity: 0.72,
    borderAccent: [0.23, 0.36, 0.86],
    borderStroke: 2.4,
    borderBlur: 12.0,
    borderFade: 0.92,
  },
};

/**
 * 构建 `InputShield` 原生 `WebContentsView` 文档：
 * - Agent 运行态默认走三层 EGO 风格 WebGL 着色器（61410 流光面纱 + 61411 点阵波纹与光标星火轨迹 + 61412 Poisson 模糊滚动边框）；
 * - 空闲/隐藏/卸载/减弱动态时彻底停帧（`requestAnimationFrame` 清零），规避后台 GPU 空转；
 * - 若 WebGL 不可用或编译失败自动降级回 CSS 呼吸边框（`body.webgl-fallback`）。
 */
export function buildShieldHtml(): string {
  const palettesJson = JSON.stringify(SHIELD_PALETTES);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; width: 100%;
    background: transparent; overflow: hidden;
    font: 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  #catch {
    position: fixed; inset: 0;
    cursor: default;
    border-radius: 8px;
  }
  body[data-mode="agent"] #catch {
    cursor: progress;
  }
  #shield-gl {
    position: fixed; inset: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 2; border-radius: 8px;
    opacity: 0; transition: opacity 0.22s ease;
  }
  body[data-mode="agent"]:not(.webgl-fallback) #shield-gl {
    opacity: 1;
  }
  #aura {
    position: fixed; inset: 0; pointer-events: none; border-radius: 8px; z-index: 3;
    transition: box-shadow 0.24s ease, border-color 0.24s ease, opacity 0.2s ease;
  }
  body[data-mode="idle"] #aura {
    border: 2px dashed rgba(99, 115, 138, 0.9);
    box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.28);
  }
  body[data-theme="light"][data-mode="idle"] #aura {
    border: 2px dashed rgba(51, 65, 85, 0.86);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.75);
  }
  body[data-mode="agent"]:not(.webgl-fallback) #aura {
    border: 0; box-shadow: none;
  }
  body.webgl-fallback[data-mode="agent"] #aura {
    border: 0;
    box-shadow:
      inset 0 0 0 2.5px rgba(91, 140, 255, 0.9),
      inset 0 0 28px rgba(56, 189, 248, 0.24);
  }
  body.webgl-fallback[data-theme="light"][data-mode="agent"] #aura {
    border: 0;
    box-shadow:
      inset 0 0 0 2.5px rgba(59, 91, 219, 0.88),
      inset 0 0 26px rgba(37, 99, 235, 0.18);
  }
  #sweep {
    position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 4;
    pointer-events: none; opacity: 0; border-radius: 8px 8px 0 0;
    background: linear-gradient(90deg, transparent 0%, #5b8cff 38%, #38bdf8 66%, transparent 100%);
    background-size: 46% 100%; background-repeat: no-repeat;
    box-shadow: 0 1px 12px rgba(91, 140, 255, 0.48);
    transition: opacity 0.2s ease;
  }
  body[data-theme="light"] #sweep {
    background: linear-gradient(90deg, transparent 0%, #3b5bdb 38%, #0284c7 66%, transparent 100%);
    background-size: 46% 100%; background-repeat: no-repeat;
    box-shadow: 0 1px 10px rgba(59, 91, 219, 0.36);
  }
  body.webgl-fallback[data-mode="agent"] #sweep { opacity: 0.98; }
  @media (prefers-reduced-motion: reduce) {
    #shield-gl { display: none; }
    body[data-mode="agent"] #aura {
      border: 0;
      box-shadow:
        inset 0 0 0 2.5px rgba(91, 140, 255, 0.85),
        inset 0 0 22px rgba(56, 189, 248, 0.18);
    }
    body[data-theme="light"][data-mode="agent"] #aura {
      box-shadow:
        inset 0 0 0 2.5px rgba(59, 91, 219, 0.85),
        inset 0 0 20px rgba(37, 99, 235, 0.14);
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    body.webgl-fallback[data-mode="agent"] #aura {
      animation: haloBreath 2.6s ease-in-out infinite;
    }
    body.webgl-fallback[data-theme="light"][data-mode="agent"] #aura {
      animation: haloBreathLight 2.6s ease-in-out infinite;
    }
    body.webgl-fallback[data-mode="agent"] #sweep {
      animation: sweepBar 2.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
  }
  @keyframes haloBreath {
    0%, 100% {
      box-shadow:
        inset 0 0 0 2px rgba(91, 140, 255, 0.68),
        inset 0 0 20px rgba(56, 189, 248, 0.16);
    }
    50% {
      box-shadow:
        inset 0 0 0 3px rgba(91, 140, 255, 0.96),
        inset 0 0 36px rgba(56, 189, 248, 0.3);
    }
  }
  @keyframes haloBreathLight {
    0%, 100% {
      box-shadow:
        inset 0 0 0 2.5px rgba(59, 91, 219, 0.68),
        inset 0 0 20px rgba(37, 99, 235, 0.14);
    }
    50% {
      box-shadow:
        inset 0 0 0 3px rgba(59, 91, 219, 0.94),
        inset 0 0 32px rgba(37, 99, 235, 0.24);
    }
  }
  @keyframes sweepBar {
    0% { background-position: -60% 0; }
    100% { background-position: 160% 0; }
  }
  #status-chip {
    position: fixed; bottom: 14px; right: 14px; z-index: 8;
    display: inline-flex; align-items: center; gap: 7px;
    padding: 4px 10px; border-radius: 999px;
    background: rgba(24, 27, 33, 0.88); color: #f4f6fa;
    border: 1px solid rgba(91, 140, 255, 0.42);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(12px);
    font: 500 11.5px/16px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    transition: left 0.26s ease, right 0.26s ease, opacity 0.2s ease;
    pointer-events: auto;
  }
  #status-chip.dodge-left { right: auto; left: 14px; }
  body[data-mode="idle"] #status-chip {
    border-color: rgba(116, 128, 150, 0.38);
    background: rgba(24, 27, 33, 0.82);
  }
  body[data-theme="light"] #status-chip {
    background: rgba(255, 255, 255, 0.92); color: #111621;
    border-color: rgba(59, 91, 219, 0.36);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.9);
  }
  body[data-theme="light"][data-mode="idle"] #status-chip {
    border-color: rgba(100, 112, 135, 0.34);
  }
  #status-dot {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
    background: #748096;
  }
  body[data-mode="agent"] #status-dot {
    background: #5b8cff;
    box-shadow: 0 0 8px rgba(91, 140, 255, 0.8);
  }
  body[data-theme="light"][data-mode="agent"] #status-dot {
    background: #3b5bdb;
  }
  #status-chip a {
    display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 999px;
    background: rgba(91, 140, 255, 0.22); color: #dbeafe; text-decoration: none;
    border: 1px solid rgba(91, 140, 255, 0.42); font-size: 11px;
  }
  body[data-theme="light"] #status-chip a {
    background: rgba(59, 91, 219, 0.12); color: #1e40af;
    border-color: rgba(59, 91, 219, 0.34);
  }
  #status-chip a:hover { filter: brightness(1.1); }
  #target-box {
    position: fixed; pointer-events: none; opacity: 0; z-index: 6;
    border: 2px solid #5b8cff;
    background: rgba(91, 140, 255, 0.08);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7), 0 0 0 4px rgba(91, 140, 255, 0.2);
    border-radius: 7px;
    transition:
      left 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      width 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      height 0.34s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.22s ease;
  }
  body[data-theme="light"] #target-box {
    border-color: #3b5bdb;
    background: rgba(59, 91, 219, 0.07);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.85), 0 0 0 4px rgba(59, 91, 219, 0.18);
  }
  #target-tag {
    position: fixed; pointer-events: none; opacity: 0; z-index: 7;
    padding: 2px 7px; border-radius: 5px;
    background: rgba(59, 91, 219, 0.95); color: #ffffff;
    font: 500 10.5px/15px ui-monospace, SFMono-Regular, Menlo, monospace;
    box-shadow: 0 4px 12px rgba(15, 23, 42, 0.25);
    white-space: nowrap; max-width: 240px; overflow: hidden; text-overflow: ellipsis;
    transition: left 0.34s cubic-bezier(0.22, 1, 0.36, 1), top 0.34s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
  }
  #cursor {
    position: fixed; pointer-events: none; opacity: 0; z-index: 9;
    transform: translate(-2px, -2px);
    filter: drop-shadow(0 2px 6px rgba(59, 91, 219, 0.5));
    transition:
      left 0.38s cubic-bezier(0.22, 1, 0.36, 1),
      top 0.38s cubic-bezier(0.22, 1, 0.36, 1),
      opacity 0.25s ease;
  }
  #ripple {
    position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; z-index: 7;
    border-radius: 50%; border: 2px solid #5b8cff;
    pointer-events: none; opacity: 0;
  }
  #ripple.pop {
    animation: rippleOut 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes rippleOut {
    0% { transform: scale(0.3); opacity: 0.9; }
    100% { transform: scale(1.9); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    #target-box, #target-tag, #cursor { transition: opacity 0.15s ease; }
    #ripple.pop { animation: none; opacity: 0; }
  }
  #nudge {
    position: fixed; z-index: 10;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 7px 5px 11px; border-radius: 999px;
    background: rgba(20, 22, 28, 0.92); color: #e5e7eb;
    border: 1px solid rgba(56, 189, 248, 0.35);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(12px);
    white-space: nowrap; opacity: 0; pointer-events: none;
    transform: translate(-50%, -125%);
    transition: opacity 0.16s ease;
  }
  #nudge.show { opacity: 1; pointer-events: auto; }
  body[data-theme="light"] #nudge {
    background: rgba(255, 255, 255, 0.94); color: #0f172a;
    border-color: rgba(2, 132, 199, 0.32);
    box-shadow: 0 10px 26px rgba(15, 23, 42, 0.14);
  }
  body[data-theme="light"] #nudge a {
    background: rgba(2, 132, 199, 0.14); color: #0369a1;
    border-color: rgba(2, 132, 199, 0.35);
  }
  body[data-theme="light"] #nudge a:hover { background: rgba(2, 132, 199, 0.24); }
  #nudge a {
    display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
    background: rgba(56, 189, 248, 0.22); color: #bae6fd; text-decoration: none;
    font-weight: 500; border: 1px solid rgba(56, 189, 248, 0.38); cursor: pointer;
  }
  #nudge a:hover { background: rgba(56, 189, 248, 0.36); }
</style></head>
<body data-mode="idle" data-theme="dark">
  <div id="catch"></div>
  <canvas id="shield-gl" aria-hidden="true"></canvas>
  <div id="aura"></div>
  <div id="sweep"></div>
  <div id="status-chip"><span id="status-dot"></span><span id="status-text"></span></div>
  <div id="target-box"></div>
  <div id="target-tag"></div>
  <div id="ripple"></div>
  <svg id="cursor" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 2l15 10.5-6.6 1.5L9.5 20 4 2z" fill="#3b5bdb" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
  </svg>
  <div id="nudge"><span id="nudge-text"></span><a id="nudge-takeover" href="warren-action://takeover">接管</a></div>
  <script>
    (() => {
      const PALETTES = ${palettesJson};
      const state = {
        caller: 'Agent',
        mode: 'idle',
        theme: 'dark',
        showControlPill: true,
        attached: false,
        visible: true,
      };
      const catchEl = document.getElementById('catch');
      const canvas = document.getElementById('shield-gl');
      const statusChip = document.getElementById('status-chip');
      const statusText = document.getElementById('status-text');
      const targetBox = document.getElementById('target-box');
      const targetTag = document.getElementById('target-tag');
      const cursor = document.getElementById('cursor');
      const ripple = document.getElementById('ripple');
      const nudge = document.getElementById('nudge');
      const nudgeText = document.getElementById('nudge-text');
      const nudgeAction = document.getElementById('nudge-takeover');
      let boxTimer = 0;
      let cursorTimer = 0;
      let nudgeTimer = 0;
      let chipTimer = 0;

      const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      const gl = canvas ? canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        powerPreference: 'low-power',
      }) : null;

      let glReady = false;
      let progVeil = null;
      let progGrid = null;
      let progBorder = null;
      const locCache = new Map();

      function compileShader(type, src) {
        if (!gl) return null;
        const s = gl.createShader(type);
        if (!s) return null;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          gl.deleteShader(s);
          return null;
        }
        return s;
      }

      function buildProgram(vsSrc, fsSrc) {
        if (!gl) return null;
        const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return null;
        const p = gl.createProgram();
        if (!p) return null;
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
          gl.deleteProgram(p);
          return null;
        }
        return p;
      }

      function uniformLoc(prog, name) {
        let map = locCache.get(prog);
        if (!map) {
          map = new Map();
          locCache.set(prog, map);
        }
        if (map.has(name)) return map.get(name);
        const loc = gl.getUniformLocation(prog, name);
        map.set(name, loc);
        return loc;
      }

      function initWebGL() {
        if (!gl) return false;
        const VS = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';
        // EGO Layer 1 (RESOURCE 61410): Domain-warped fBm aura veil
        const FS_VEIL = [
          'precision mediump float;',
          'uniform vec2 uResolution;',
          'uniform float uTime;',
          'uniform float uIntensity;',
          'uniform vec4 uColorA;',
          'uniform vec4 uColorB;',
          'uniform vec4 uColorC;',
          'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
          'float vnoise(vec2 p) {',
          '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
          '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
          '}',
          'float fbm_norm(vec2 p) {',
          '  float v = 0.0; float a = 0.5; float total = 0.0;',
          '  for (int i = 0; i < 5; ++i) { v += a * vnoise(p); total += a; p *= 2.02; a *= 0.5; }',
          '  return v / max(total, 0.0001);',
          '}',
          'void main() {',
          '  vec2 frag = gl_FragCoord.xy;',
          '  frag.y = uResolution.y - frag.y;',
          '  vec2 uv = frag / max(uResolution, vec2(1.0));',
          '  vec2 flowA = vec2(uTime * 0.16 * 0.6, uTime * 0.16 * 0.45);',
          '  vec2 flowB = vec2(-uTime * 0.16 * 0.35, uTime * 0.16 * 0.55);',
          '  vec2 p = uv * 2.2 + flowA;',
          '  vec2 q = vec2(fbm_norm(p), fbm_norm(p + vec2(5.2, 1.3)));',
          '  float n = fbm_norm(p + q * 0.85 + flowB);',
          '  float t = clamp((n - 0.5) * 1.45 + 0.5, 0.0, 1.0);',
          '  vec4 lo = mix(uColorA, uColorB, t * 2.0);',
          '  vec4 hi = mix(uColorB, uColorC, (t - 0.5) * 2.0);',
          '  vec4 mixed = mix(lo, hi, step(0.5, t));',
          '  vec3 col = mix(vec3(1.0), mixed.rgb, uIntensity);',
          '  float a = clamp(mixed.a, 0.0, 1.0);',
          '  gl_FragColor = vec4(col * a, a);',
          '}',
        ].join('\\n');

        // EGO Layer 2 (RESOURCE 61411): Dot-matrix + dither spark + radial ripple + 15-pt pointer trail
        const FS_GRID = [
          'precision highp float;',
          'uniform vec2 uResolution;',
          'uniform float uTime;',
          'uniform float uDpr;',
          'uniform vec2 uRippleOrigin;',
          'uniform float uRippleMix;',
          'uniform vec3 uDotColor;',
          'uniform float uDotOpacity;',
          'uniform vec3 uSparkColor;',
          'uniform float uSparkOpacity;',
          'uniform float uTrailStrength;',
          'uniform vec4 uTrail[15];',
          'float hash21(vec2 p) {',
          '  vec2 q = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;',
          '  q = q + dot(q, q + 19.19);',
          '  return fract(q.x * q.y);',
          '}',
          'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
          'float vnoise(vec2 p) {',
          '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
          '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
          '}',
          'float fbm_grid(vec2 p) {',
          '  float v = 0.0; float a = 0.5;',
          '  for (int i = 0; i < 5; ++i) { v += a * vnoise(p); p *= 2.02; a *= 0.5; }',
          '  return v;',
          '}',
          'float compute_trail(vec2 frag) {',
          '  float r = 74.0 * uDpr;',
          '  float r2 = max(r * r, 1.0);',
          '  float s = 0.0;',
          '  for (int i = 0; i < 15; ++i) {',
          '    vec2 d = frag - uTrail[i].xy;',
          '    s += uTrail[i].z * exp(-dot(d, d) / r2);',
          '  }',
          '  return s * uTrailStrength;',
          '}',
          'float noise_brightness(vec2 center, vec2 frag, float cov, float soft, float inten) {',
          '  vec2 uv = center / max(uResolution, vec2(1.0));',
          '  vec2 fa = vec2(uTime * 0.2 * 0.6, uTime * 0.2 * 0.45);',
          '  vec2 fb = vec2(-uTime * 0.2 * 0.35, uTime * 0.2 * 0.55);',
          '  float nf = fbm_grid(uv * 2.8 + fa + fb);',
          '  float nr = 0.5 + 0.5 * sin(distance(uv, uRippleOrigin) * 20.0 - uTime * 2.6);',
          '  float n = mix(nf, nf * nr, clamp(uRippleMix, 0.0, 1.0)) + compute_trail(frag);',
          '  float th = 1.0 - cov;',
          '  return smoothstep(th - soft, th + soft, n) * inten;',
          '}',
          'void main() {',
          '  vec2 frag = gl_FragCoord.xy;',
          '  float spacing = 10.0 * uDpr;',
          '  float size = 2.0 * uDpr;',
          '  vec2 cell = floor(frag / spacing);',
          '  vec2 to_c = (frag - cell * spacing) - vec2(spacing * 0.5);',
          '  if (abs(to_c.x) > size * 0.5 || abs(to_c.y) > size * 0.5) { gl_FragColor = vec4(0.0); return; }',
          '  vec2 center = (cell + 0.5) * spacing;',
          '  float ba = noise_brightness(center, frag, 0.42, 0.18, 0.9);',
          '  float aa = clamp(ba, 0.0, 1.0) * uDotOpacity;',
          '  vec4 outc = vec4(uDotColor * aa, aa);',
          '  float bd = noise_brightness(center, frag, 0.36, 0.14, 1.15);',
          '  if (bd > hash21(cell)) {',
          '    float da = uSparkOpacity;',
          '    vec4 src = vec4(uSparkColor * da, da);',
          '    outc = src + outc * (1.0 - src.a);',
          '  }',
          '  gl_FragColor = outc;',
          '}',
        ].join('\\n');

        // EGO Layer 3 (RESOURCE 61412/61413): Poisson-blurred rounded-rect stroke + scrolling ramp
        const FS_BORDER = [
          'precision mediump float;',
          'uniform vec2 uResolution;',
          'uniform float uDpr;',
          'uniform float uStroke;',
          'uniform float uBlur;',
          'uniform float uRadius;',
          'uniform float uFade;',
          'uniform vec3 uAccent;',
          'uniform float uScrollOffset;',
          'float hash21(vec2 p) {',
          '  vec2 q = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;',
          '  q = q + dot(q, q + 19.19);',
          '  return fract(q.x * q.y);',
          '}',
          'float ringDist(vec2 p_in) {',
          '  float r = max(uRadius, 0.0);',
          '  vec2 h = uResolution * 0.5;',
          '  vec2 p = abs(p_in - h) - (h - vec2(r));',
          '  return -(length(max(p, vec2(0.0))) + min(max(p.x, p.y), 0.0) - r);',
          '}',
          'float hardStroke(vec2 p) {',
          '  float d = ringDist(p);',
          '  float halfS = max(uStroke * 2.6, 4.0);',
          '  return smoothstep(halfS, 0.0, abs(d));',
          '}',
          'float sampleStroke(vec2 fc, float blur, float cs, float sn, vec2 off) {',
          '  vec2 rot = vec2(off.x * cs - off.y * sn, off.x * sn + off.y * cs);',
          '  return hardStroke(fc + rot * blur);',
          '}',
          'vec4 rampColor(float t_in) {',
          '  float t = fract(t_in);',
          '  vec4 a = vec4(uAccent, 0.96);',
          '  vec4 m = vec4(uAccent, 0.28);',
          '  vec4 lo = mix(a, m, smoothstep(0.0, 0.5, t));',
          '  vec4 hi = mix(m, a, smoothstep(0.5, 1.0, t));',
          '  return t < 0.5 ? lo : hi;',
          '}',
          'void main() {',
          '  vec2 fc = gl_FragCoord.xy;',
          '  float edgeDist = ringDist(fc);',
          '  if (edgeDist < -0.5) { gl_FragColor = vec4(0.0); return; }',
          '  float blur = max(uBlur * uDpr, 0.5);',
          '  float th = hash21(fc) * 6.2831853;',
          '  float cs = cos(th); float sn = sin(th);',
          '  float sum = hardStroke(fc) * 1.00000000;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.5253, -0.1547)) * 0.54895195;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.4254, -0.3611)) * 0.53648497;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.0840, 0.6276)) * 0.44848703;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.6783, 0.2515)) * 0.35109927;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.2049, -0.8231)) * 0.23717542;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.7975, 0.4521)) * 0.18622469;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.8654, -0.1832)) * 0.20909663;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.1521, -0.5736)) * 0.49445322;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.5612, 0.2138)) * 0.48611417;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.1834, 0.3015)) * 0.77952102;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.4421, 0.7531)) * 0.21757231;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.8123, -0.4986)) * 0.16253425;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(-0.7211, -0.6173)) * 0.16495394;',
          '  sum += sampleStroke(fc, blur, cs, sn, vec2(0.2412, -0.9012)) * 0.17540148;',
          '  float tile = max(uResolution.y, 1.0);',
          '  float scroll = mod(uScrollOffset, tile);',
          '  float t = (fc.y + scroll) / tile;',
          '  vec4 ramp = rampColor(t);',
          '  float bloom = (sum / 6.22071317) * clamp(uFade, 0.0, 1.0) * ramp.a;',
          '  float crispRim = smoothstep(2.6 * uDpr, 0.0, max(0.0, edgeDist)) * mix(0.55, 0.96, ramp.a);',
          '  float alpha = clamp(max(crispRim, bloom * 0.72), 0.0, 1.0);',
          '  gl_FragColor = vec4(ramp.rgb * alpha, alpha);',
          '}',
        ].join('\\n');

        progVeil = buildProgram(VS, FS_VEIL);
        progGrid = buildProgram(VS, FS_GRID);
        progBorder = buildProgram(VS, FS_BORDER);
        if (!progVeil || !progGrid || !progBorder) return false;

        const buf = gl.createBuffer();
        if (!buf) return false;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        return true;
      }

      glReady = initWebGL();
      if (!glReady) {
        document.body.classList.add('webgl-fallback');
      }

      let rafId = 0;
      let elapsed = 0.8;
      let lastTs = 0;
      let cssWidth = Math.max(1, window.innerWidth);
      let cssHeight = Math.max(1, window.innerHeight);
      let dpr = Math.min(window.devicePixelRatio || 1, 2);

      // 轨迹点与水波扩散状态
      const trail = new Float32Array(15 * 4);
      const cursorTarget = { x: cssWidth * 0.5, y: cssHeight * 0.5, hasAction: false, until: 0 };
      const cursorVisual = { x: cssWidth * 0.5, y: cssHeight * 0.5 };
      const rippleState = { x: 0.5, y: 0.5, mix: 0.25 };

      function bindQuad(prog) {
        const loc = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }

      function resizeCanvas() {
        if (!glReady || !canvas) return;
        cssWidth = Math.max(1, window.innerWidth);
        cssHeight = Math.max(1, window.innerHeight);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(cssWidth * dpr));
        canvas.height = Math.max(1, Math.round(cssHeight * dpr));
        gl.viewport(0, 0, canvas.width, canvas.height);
        if (shouldRunLoop() || (glReady && state.mode === 'agent' && state.attached && state.visible)) {
          renderGlFrame();
        }
      }

      function stepMotion(dt) {
        const now = performance.now();
        for (let i = 14; i > 0; i--) {
          trail[i * 4] = trail[(i - 1) * 4];
          trail[i * 4 + 1] = trail[(i - 1) * 4 + 1];
          trail[i * 4 + 2] = Math.max(0, trail[(i - 1) * 4 + 2] - dt * 1.15);
        }
        const activeTarget = cursorTarget.hasAction && now < cursorTarget.until;
        if (activeTarget) {
          const factor = 1 - Math.exp(-dt * 14);
          cursorVisual.x += (cursorTarget.x - cursorVisual.x) * factor;
          cursorVisual.y += (cursorTarget.y - cursorVisual.y) * factor;
          trail[0] = cursorVisual.x * dpr;
          trail[1] = canvas.height - cursorVisual.y * dpr;
          trail[2] = 1.0;
        } else {
          cursorTarget.hasAction = false;
          trail[2] = Math.max(0, trail[2] - dt * 2.0);
        }
        rippleState.mix = Math.max(0.24, rippleState.mix - dt * 0.45);
      }

      function renderGlFrame() {
        if (!glReady || !gl) return;
        if (!state.attached || !state.visible || state.mode !== 'agent') {
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          return;
        }
        const pal = PALETTES[state.theme] || PALETTES.dark;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        // Layer 1: Veil
        gl.useProgram(progVeil);
        bindQuad(progVeil);
        gl.uniform2f(uniformLoc(progVeil, 'uResolution'), canvas.width, canvas.height);
        gl.uniform1f(uniformLoc(progVeil, 'uTime'), elapsed);
        gl.uniform1f(uniformLoc(progVeil, 'uIntensity'), pal.veilIntensity);
        gl.uniform4fv(uniformLoc(progVeil, 'uColorA'), pal.colorA);
        gl.uniform4fv(uniformLoc(progVeil, 'uColorB'), pal.colorB);
        gl.uniform4fv(uniformLoc(progVeil, 'uColorC'), pal.colorC);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Layer 2: Dot-grid + dither spark + cursor trail
        gl.useProgram(progGrid);
        bindQuad(progGrid);
        gl.uniform2f(uniformLoc(progGrid, 'uResolution'), canvas.width, canvas.height);
        gl.uniform1f(uniformLoc(progGrid, 'uTime'), elapsed);
        gl.uniform1f(uniformLoc(progGrid, 'uDpr'), dpr);
        gl.uniform2f(uniformLoc(progGrid, 'uRippleOrigin'), rippleState.x, rippleState.y);
        gl.uniform1f(uniformLoc(progGrid, 'uRippleMix'), rippleState.mix);
        gl.uniform3fv(uniformLoc(progGrid, 'uDotColor'), pal.dotColor);
        gl.uniform1f(uniformLoc(progGrid, 'uDotOpacity'), pal.dotOpacity);
        gl.uniform3fv(uniformLoc(progGrid, 'uSparkColor'), pal.sparkColor);
        gl.uniform1f(uniformLoc(progGrid, 'uSparkOpacity'), pal.sparkOpacity);
        gl.uniform1f(uniformLoc(progGrid, 'uTrailStrength'), 0.65);
        gl.uniform4fv(uniformLoc(progGrid, 'uTrail'), trail);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Layer 3: Poisson-blurred scrolling border glow
        gl.useProgram(progBorder);
        bindQuad(progBorder);
        gl.uniform2f(uniformLoc(progBorder, 'uResolution'), canvas.width, canvas.height);
        gl.uniform1f(uniformLoc(progBorder, 'uDpr'), dpr);
        gl.uniform1f(uniformLoc(progBorder, 'uStroke'), pal.borderStroke * dpr);
        gl.uniform1f(uniformLoc(progBorder, 'uBlur'), pal.borderBlur);
        gl.uniform1f(uniformLoc(progBorder, 'uRadius'), 8.0 * dpr);
        gl.uniform1f(uniformLoc(progBorder, 'uFade'), pal.borderFade);
        gl.uniform3fv(uniformLoc(progBorder, 'uAccent'), pal.borderAccent);
        gl.uniform1f(uniformLoc(progBorder, 'uScrollOffset'), elapsed * 180.0 * dpr);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      function shouldRunLoop() {
        return Boolean(
          glReady &&
          state.attached &&
          state.visible &&
          state.mode === 'agent' &&
          !document.hidden &&
          !(motionQuery && motionQuery.matches),
        );
      }

      function tick(ts) {
        rafId = 0;
        if (!shouldRunLoop()) return;
        const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 0.016;
        lastTs = ts;
        elapsed += dt;
        stepMotion(dt);
        renderGlFrame();
        rafId = requestAnimationFrame(tick);
      }

      function syncAnimationLoop() {
        if (shouldRunLoop()) {
          if (!rafId) {
            lastTs = 0;
            rafId = requestAnimationFrame(tick);
          }
        } else {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
          renderGlFrame();
        }
      }

      function syncChip(actionLabel) {
        if (!state.showControlPill || state.mode !== 'agent') {
          statusChip.style.display = 'none';
          statusChip.classList.remove('dodge-left');
          return;
        }
        statusChip.style.display = 'inline-flex';
        statusText.textContent = actionLabel ? actionLabel : '实时执行中';
      }

      function hideTraces() {
        clearTimeout(boxTimer);
        clearTimeout(cursorTimer);
        clearTimeout(chipTimer);
        targetBox.style.opacity = '0';
        targetTag.style.opacity = '0';
        cursor.style.opacity = '0';
        cursorTarget.hasAction = false;
        trail.fill(0);
      }

      window.__warrenShieldState = (next) => {
        if (!next) return;
        if (typeof next.caller === 'string') state.caller = next.caller || 'Agent';
        if (next.mode === 'agent' || next.mode === 'idle') state.mode = next.mode;
        if (next.theme === 'dark' || next.theme === 'light') state.theme = next.theme;
        if (typeof next.showControlPill === 'boolean') state.showControlPill = next.showControlPill;
        if (typeof next.attached === 'boolean') state.attached = next.attached;
        if (typeof next.visible === 'boolean') state.visible = next.visible;
        document.body.dataset.mode = state.mode;
        document.body.dataset.theme = state.theme;
        syncChip();
        if (state.mode !== 'agent' || !state.attached || !state.visible) hideTraces();
        syncAnimationLoop();
      };

      window.__warrenShieldAction = (act) => {
        if (!act || state.mode !== 'agent') return;
        const x = Number(act.x);
        const y = Number(act.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const nearBottomRight =
          y > Math.max(120, window.innerHeight - 96) && x > Math.max(260, window.innerWidth - 280);
        statusChip.classList.toggle('dodge-left', nearBottomRight);
        syncChip(act.label || act.kind);
        clearTimeout(chipTimer);
        chipTimer = setTimeout(() => { if (state.mode === 'agent') syncChip(); }, 2800);
        const hasRect = act.rect && act.rect.width > 0 && act.rect.height > 0;
        const cursorX = hasRect && act.kind === 'fill' ? act.rect.x + act.rect.width - 4 : x;
        const cursorY = hasRect && act.kind === 'fill' ? act.rect.y + act.rect.height - 2 : y;
        cursor.style.left = cursorX + 'px';
        cursor.style.top = cursorY + 'px';
        cursor.style.opacity = '1';
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => { cursor.style.opacity = state.mode === 'agent' ? '0.48' : '0'; }, 2600);

        // 同步到 WebGL 15 点高斯尾迹与水波中心
        if (!cursorTarget.hasAction) {
          cursorVisual.x = cursorX;
          cursorVisual.y = cursorY;
        }
        cursorTarget.x = cursorX;
        cursorTarget.y = cursorY;
        cursorTarget.hasAction = true;
        cursorTarget.until = performance.now() + 1800;

        if (hasRect) {
          const rx = Math.max(0, act.rect.x - 4);
          const ry = Math.max(0, act.rect.y - 4);
          targetBox.style.left = rx + 'px';
          targetBox.style.top = ry + 'px';
          targetBox.style.width = (act.rect.width + 8) + 'px';
          targetBox.style.height = (act.rect.height + 8) + 'px';
          targetBox.style.opacity = '1';
          const tagText = act.label || act.kind;
          targetTag.textContent = tagText;
          targetTag.style.left = Math.min(rx, Math.max(8, window.innerWidth - 180)) + 'px';
          targetTag.style.top = Math.max(6, ry - 23) + 'px';
          targetTag.style.opacity = '1';
          clearTimeout(boxTimer);
          boxTimer = setTimeout(() => {
            targetBox.style.opacity = '0';
            targetTag.style.opacity = '0';
          }, 2100);
        }

        if (act.kind === 'click') {
          rippleState.x = Math.max(0, Math.min(1, x / Math.max(1, cssWidth)));
          rippleState.y = Math.max(0, Math.min(1, 1.0 - y / Math.max(1, cssHeight)));
          rippleState.mix = 0.88;
          ripple.style.left = x + 'px';
          ripple.style.top = y + 'px';
          ripple.classList.remove('pop');
          void ripple.offsetWidth;
          ripple.classList.add('pop');
        }
      };

      window.__warrenShieldStats = () => ({
        glReady,
        rafActive: rafId !== 0,
        mode: state.mode,
        theme: state.theme,
        attached: state.attached,
        visible: state.visible,
        width: canvas ? canvas.width : 0,
        height: canvas ? canvas.height : 0,
        fallback: document.body.classList.contains('webgl-fallback'),
      });

      if (canvas) {
        canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          glReady = false;
          document.body.classList.add('webgl-fallback');
          syncAnimationLoop();
        });
      }
      document.addEventListener('visibilitychange', syncAnimationLoop);
      if (motionQuery && typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', syncAnimationLoop);
      }
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(resizeCanvas).observe(document.documentElement);
      }
      window.addEventListener('resize', resizeCanvas);
      resizeCanvas();

      catchEl.addEventListener('pointerdown', (event) => {
        if (!state.showControlPill) return;
        nudgeText.textContent = state.mode === 'agent'
          ? state.caller + ' 正在操作'
          : 'Agent 空间只读';
        nudgeAction.textContent = state.mode === 'agent' ? '接管' : '接管编辑';
        const left = Math.min(Math.max(event.clientX, 120), Math.max(120, window.innerWidth - 120));
        const top = Math.max(event.clientY, 44);
        nudge.style.left = left + 'px';
        nudge.style.top = top + 'px';
        nudge.classList.add('show');
        clearTimeout(nudgeTimer);
        nudgeTimer = setTimeout(() => { nudge.classList.remove('show'); }, 1800);
      });
    })();
  </script>
</body></html>`;
}
