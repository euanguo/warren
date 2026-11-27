export type ShieldMode = 'agent' | 'idle';
export type ShieldTheme = 'dark' | 'light';
export type ShieldPhase = 'acting' | 'thinking';

export interface ShieldSessionSnapshot {
  phase: ShieldPhase;
  startedAt: number;
  lastActivityAt: number;
  lastAction?: string;
  actionCount: number;
}

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

/** 仅当遮罩挂载、窗口/舞台可见、处于 Agent 托管操作态且系统未开启减弱动画时启用动态光效。 */
export function shouldShieldAnimate(input: ShieldAnimationInput): boolean {
  return Boolean(input.attached && input.visible && input.mode === 'agent' && !input.reducedMotion && !input.hidden);
}

/**
 * 构建 Ardia `PowerUp + Halo` 慢流速物理光场透明护盾（WebGL2 空心四边裁剪 + 纯 CSS 自动降级）：
 * - 核心光场：Oklab 6 色光谱插值 + 3D Simplex Noise 调制宽幅半影 + 双对称追光弧 + 入场 PowerUp 光浪 + 点击阻尼爆发 + 三角抖动去色带；
 * - 极低 GPU 占用：全局单实例按需挂载；1.6s 入场光浪结束后自动切换「空心四边条带几何体」（中心网页区 0 片元着色开销），
 *   `acting` 节流至 ~45fps、`thinking` 慢流速节流至 ~24fps，隐藏/切走/空闲/减弱动态时彻底 `cancelAnimationFrame` 零耗电；
 * - 视觉交互：底部居中 macOS 液态玻璃 HUD 胶囊（Dia 光谱核 + 状态 + 计时器 +「接管 / 结束」双按钮）+ 渐变 AI 箭头光标与目标锁定框；
 * - 兜底保障：若环境不可用 WebGL2 自动无缝降级至纯 CSS 棱镜光环；关闭底部胶囊时误点仍弹出非阻塞提示。
 */
export function buildShieldHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @property --prism-angle {
    syntax: '<angle>';
    inherits: false;
    initial-value: 0deg;
  }
  :root {
    --hud-bg: rgba(16, 19, 28, 0.80);
    --hud-border: rgba(255, 255, 255, 0.16);
    --hud-fg: #f8fafc;
    --hud-muted: rgba(226, 232, 240, 0.68);
    --hud-shadow: 0 12px 32px rgba(2, 6, 23, 0.42), 0 1px 0 rgba(255, 255, 255, 0.14) inset;
    --orb-grad: conic-gradient(from 0deg, #0358f7, #5092c7, #c7bdfe, #ffc738, #fa3d1d, #fd14e0, #0358f7);
    --orb-core: #60a5fa;
    --btn-takeover-bg: rgba(59, 130, 246, 0.22);
    --btn-takeover-bg-hover: rgba(59, 130, 246, 0.34);
    --btn-takeover-fg: #bfdbfe;
    --btn-takeover-border: rgba(96, 165, 250, 0.44);
    --btn-finish-bg: rgba(148, 163, 184, 0.15);
    --btn-finish-bg-hover: rgba(248, 113, 113, 0.22);
    --btn-finish-fg: #cbd5e1;
    --btn-finish-fg-hover: #fecaca;
    --btn-finish-border: rgba(148, 163, 184, 0.26);
  }
  body[data-theme="light"] {
    --hud-bg: rgba(255, 255, 255, 0.84);
    --hud-border: rgba(15, 23, 42, 0.13);
    --hud-fg: #0f172a;
    --hud-muted: rgba(71, 85, 105, 0.78);
    --hud-shadow: 0 10px 28px rgba(15, 23, 42, 0.15), 0 1px 0 rgba(255, 255, 255, 0.94) inset;
    --orb-core: #2563eb;
    --btn-takeover-bg: rgba(37, 99, 235, 0.11);
    --btn-takeover-bg-hover: rgba(37, 99, 235, 0.20);
    --btn-takeover-fg: #1d4ed8;
    --btn-takeover-border: rgba(37, 99, 235, 0.30);
    --btn-finish-bg: rgba(15, 23, 42, 0.05);
    --btn-finish-bg-hover: rgba(220, 38, 38, 0.12);
    --btn-finish-fg: #475569;
    --btn-finish-fg-hover: #b91c1c;
    --btn-finish-border: rgba(15, 23, 42, 0.14);
  }
  body[data-stale="true"] {
    --hud-border: rgba(245, 158, 11, 0.52);
    --orb-grad: conic-gradient(from 0deg, #f59e0b, #fbbf24, #f97316, #fef3c7, #f59e0b);
    --orb-core: #fbbf24;
    --btn-finish-bg: rgba(245, 158, 11, 0.22);
    --btn-finish-bg-hover: rgba(245, 158, 11, 0.36);
    --btn-finish-fg: #fde68a;
    --btn-finish-fg-hover: #fef3c7;
    --btn-finish-border: rgba(251, 191, 36, 0.55);
  }
  body[data-theme="light"][data-stale="true"] {
    --btn-finish-bg: rgba(217, 119, 6, 0.14);
    --btn-finish-bg-hover: rgba(217, 119, 6, 0.24);
    --btn-finish-fg: #b45309;
    --btn-finish-fg-hover: #92400e;
    --btn-finish-border: rgba(217, 119, 6, 0.42);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; width: 100%;
    background: transparent; overflow: hidden;
    font: 12px -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  #catch {
    position: fixed; inset: 0;
    cursor: progress;
    border-radius: 10px;
  }
  body[data-phase="thinking"] #catch { cursor: default; }

  /* WebGL2 物理光场画布 */
  #shield-canvas {
    position: fixed; inset: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 2; border-radius: 10px;
    display: block;
  }
  body[data-renderer="css"] #shield-canvas { display: none; }

  /* 纯 CSS 降级兜底层（仅在 WebGL2 不可用时显示） */
  #aura, #prism-ring, #sweep {
    position: fixed; pointer-events: none; display: none;
  }
  body[data-renderer="css"] #aura,
  body[data-renderer="css"] #prism-ring,
  body[data-renderer="css"] #sweep { display: block; }
  #aura {
    inset: 0; border-radius: 10px; z-index: 2;
    box-shadow: inset 0 0 26px rgba(59, 130, 246, 0.20), inset 0 0 58px rgba(253, 20, 224, 0.08);
  }
  #prism-ring {
    inset: 0; border-radius: 10px; z-index: 3; padding: 2px; opacity: 0.9;
    background: conic-gradient(from var(--prism-angle), #0358f7, #5092c7, #c7bdfe, #ffc738, #fa3d1d, #fd14e0, #0358f7);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
  }
  #sweep {
    top: 0; left: 8px; right: 8px; height: 2px; z-index: 4; border-radius: 999px;
    background: linear-gradient(90deg, transparent, #3b82f6 30%, #fd14e0 70%, transparent);
    background-size: 38% 100%; background-repeat: no-repeat; opacity: 0;
  }
  body[data-renderer="css"][data-animate="true"] #prism-ring {
    animation: warren-prism-spin 9s linear infinite;
  }
  body[data-renderer="css"][data-animate="true"][data-phase="thinking"] #prism-ring {
    animation-duration: 18s; opacity: 0.72;
  }
  @keyframes warren-prism-spin {
    from { --prism-angle: 0deg; }
    to { --prism-angle: 360deg; }
  }
  @keyframes warren-orb-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes warren-scanline {
    0% { transform: translateY(-100%); opacity: 0; }
    20% { opacity: 0.65; }
    80% { opacity: 0.65; }
    100% { transform: translateY(400%); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    #prism-ring, #status-orb::before, #target-box::after { animation: none !important; }
  }

  /* 光学目标锁定框 */
  #target-box {
    position: fixed; z-index: 5; pointer-events: none; opacity: 0; overflow: hidden;
    border: 1.5px solid rgba(59, 130, 246, 0.88);
    background: rgba(59, 130, 246, 0.08);
    box-shadow: 0 0 0 1px rgba(253, 20, 224, 0.18), 0 0 18px rgba(59, 130, 246, 0.28);
    border-radius: 7px;
    transition: opacity 0.18s ease, left 0.14s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.14s cubic-bezier(0.2, 0.8, 0.2, 1), width 0.14s ease, height 0.14s ease;
  }
  #target-box::after {
    content: ''; position: absolute; left: 0; right: 0; top: 0; height: 28%;
    background: linear-gradient(180deg, transparent, rgba(147, 197, 253, 0.26), transparent);
    animation: warren-scanline 1.35s ease-in-out infinite;
  }
  #target-tag {
    position: fixed; z-index: 6; pointer-events: none; opacity: 0;
    padding: 2px 8px; border-radius: 6px;
    background: rgba(15, 23, 42, 0.88); color: #f1f5f9;
    border: 1px solid rgba(96, 165, 250, 0.42);
    box-shadow: 0 4px 12px rgba(2, 6, 23, 0.34);
    font: 500 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: opacity 0.18s ease;
  }

  /* 渐变描边 AI 箭头光标 */
  #cursor {
    position: fixed; z-index: 7; pointer-events: none; opacity: 0;
    width: 26px; height: 26px; margin: -2px 0 0 -3px;
    filter: drop-shadow(0 4px 10px rgba(3, 88, 247, 0.42));
    transition: left 0.20s cubic-bezier(0.2, 0.85, 0.25, 1), top 0.20s cubic-bezier(0.2, 0.85, 0.25, 1), opacity 0.24s ease;
  }
  #cursor svg { width: 100%; height: 100%; display: block; }
  #cursor.clicking { animation: warren-cursor-press 0.26s cubic-bezier(0.2, 0.9, 0.3, 1); }
  @keyframes warren-cursor-press {
    0% { transform: scale(1); }
    40% { transform: scale(0.82); }
    100% { transform: scale(1); }
  }

  /* 双环点击冲击波 */
  #ripple {
    position: fixed; z-index: 6; pointer-events: none; opacity: 0;
    width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 999px;
    border: 1.5px solid rgba(59, 130, 246, 0.92);
    box-shadow: 0 0 14px rgba(59, 130, 246, 0.42);
  }
  #ripple::after {
    content: ''; position: absolute; inset: -6px; border-radius: 999px;
    border: 1.2px solid rgba(253, 20, 224, 0.68); opacity: 0;
  }
  #ripple.pop { animation: warren-ripple 0.56s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  #ripple.pop::after { animation: warren-ripple-outer 0.62s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  @keyframes warren-ripple {
    0% { opacity: 0.96; transform: scale(0.28); }
    100% { opacity: 0; transform: scale(1.9); }
  }
  @keyframes warren-ripple-outer {
    0% { opacity: 0.76; transform: scale(0.42); }
    100% { opacity: 0; transform: scale(2.35); }
  }

  /* 底部居中 macOS 液态玻璃 HUD 胶囊 */
  #status-chip {
    position: fixed; left: 50%; bottom: 16px; z-index: 8;
    transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    height: 34px; padding: 0 6px 0 11px; border-radius: 999px;
    background: var(--hud-bg); color: var(--hud-fg);
    border: 1px solid var(--hud-border);
    box-shadow: var(--hud-shadow);
    backdrop-filter: blur(20px) saturate(1.65);
    -webkit-backdrop-filter: blur(20px) saturate(1.65);
    transition: opacity 0.22s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), top 0.22s ease, bottom 0.22s ease;
    max-width: calc(100vw - 32px);
  }
  #status-chip.hidden { opacity: 0; pointer-events: none; transform: translate(-50%, 8px) scale(0.96); }
  #status-chip.dodge-top { bottom: auto; top: 14px; }
  #status-orb {
    position: relative; width: 14px; height: 14px; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
  }
  #status-orb::before {
    content: ''; position: absolute; inset: 0; border-radius: 999px;
    background: var(--orb-grad);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.2px), #000 calc(100% - 1.5px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.2px), #000 calc(100% - 1.5px));
    animation: warren-orb-spin 4.2s linear infinite;
  }
  body[data-phase="thinking"] #status-orb::before { animation-duration: 9s; opacity: 0.78; }
  body[data-animate="false"] #status-orb::before { animation-play-state: paused; }
  #status-dot {
    width: 5px; height: 5px; border-radius: 999px;
    background: var(--orb-core);
    box-shadow: 0 0 8px var(--orb-core);
  }
  #status-label {
    font-size: 12px; font-weight: 500; letter-spacing: -0.01em;
    max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #status-timer {
    font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    color: var(--hud-muted);
    flex: none;
  }
  .hud-sep {
    width: 1px; height: 13px; background: currentColor; flex: none; opacity: 0.16;
  }
  .hud-btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 22px; padding: 0 9px; border-radius: 999px;
    text-decoration: none; font-weight: 500; font-size: 11px; line-height: 1;
    cursor: pointer; white-space: nowrap; flex: none;
    transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
  }
  .takeover-btn {
    background: var(--btn-takeover-bg); color: var(--btn-takeover-fg);
    border: 1px solid var(--btn-takeover-border);
  }
  .takeover-btn:hover { background: var(--btn-takeover-bg-hover); }
  .finish-btn {
    background: var(--btn-finish-bg); color: var(--btn-finish-fg);
    border: 1px solid var(--btn-finish-border);
  }
  .finish-btn:hover {
    background: var(--btn-finish-bg-hover); color: var(--btn-finish-fg-hover);
  }

  /* 误点遮罩时的非阻塞气泡提示 */
  #nudge {
    position: fixed; z-index: 9; transform: translate(-50%, -120%);
    display: flex; align-items: center; gap: 6px;
    padding: 5px 7px 5px 11px; border-radius: 999px;
    background: var(--hud-bg); color: var(--hud-fg);
    border: 1px solid var(--hud-border);
    box-shadow: var(--hud-shadow);
    backdrop-filter: blur(18px) saturate(1.5);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
    white-space: nowrap;
  }
  #nudge.show { opacity: 1; pointer-events: auto; }
  .hidden { display: none !important; }
</style></head>
<body data-mode="agent" data-theme="dark" data-phase="acting" data-stale="false" data-animate="false" data-renderer="webgl2">
  <div id="catch"></div>
  <canvas id="shield-canvas"></canvas>
  <div id="aura"></div>
  <div id="prism-ring"></div>
  <div id="sweep"></div>
  <div id="target-box"></div>
  <div id="target-tag"></div>
  <div id="cursor">
    <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="warren-cursor-grad" x1="3" y1="2" x2="24" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#0358f7"/>
          <stop offset="52%" stop-color="#fd14e0"/>
          <stop offset="100%" stop-color="#fa3d1d"/>
        </linearGradient>
      </defs>
      <path d="M5.2 3.2L22.6 12.2C23.7 12.8 23.5 14.4 22.3 14.7L14.9 16.5L11.7 23.2C11.1 24.3 9.5 24.1 9.2 22.9L4.1 4.6C3.8 3.6 4.4 2.8 5.2 3.2Z"
        fill="rgba(255,255,255,0.96)" stroke="url(#warren-cursor-grad)" stroke-width="2.1" stroke-linejoin="round"/>
    </svg>
  </div>
  <div id="ripple"></div>
  <div id="status-chip" class="hidden">
    <span id="status-orb"><span id="status-dot"></span></span>
    <span id="status-label">Agent 执行中</span>
    <span id="status-timer">00:00</span>
    <span class="hud-sep"></span>
    <a class="hud-btn takeover-btn" href="warren-action://takeover" title="暂停 AI 写入并接管页面">接管</a>
    <a class="hud-btn finish-btn" href="warren-action://finish" title="结束 AI 托管模式并关闭蒙层">结束</a>
  </div>
  <div id="nudge">
    <span id="nudge-text">Agent 正在托管操作</span>
    <a id="nudge-takeover" class="hud-btn takeover-btn" href="warren-action://takeover">接管</a>
    <a id="nudge-finish" class="hud-btn finish-btn" href="warren-action://finish">结束</a>
  </div>
  <script>
    (() => {
      const STALE_MS = 300000;
      const INTRO_FULLSCREEN_SEC = 1.65;
      const state = {
        caller: 'Agent',
        mode: 'idle',
        theme: 'dark',
        phase: 'acting',
        startedAt: 0,
        lastActivityAt: 0,
        lastAction: '',
        actionCount: 0,
        showControlPill: true,
        attached: false,
        visible: false,
      };
      const catchEl = document.getElementById('catch');
      const canvas = document.getElementById('shield-canvas');
      const statusChip = document.getElementById('status-chip');
      const statusLabel = document.getElementById('status-label');
      const statusTimer = document.getElementById('status-timer');
      const targetBox = document.getElementById('target-box');
      const targetTag = document.getElementById('target-tag');
      const cursor = document.getElementById('cursor');
      const ripple = document.getElementById('ripple');
      const nudge = document.getElementById('nudge');
      const nudgeText = document.getElementById('nudge-text');
      const nudgeTakeover = document.getElementById('nudge-takeover');
      const nudgeFinish = document.getElementById('nudge-finish');
      const motionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      let chipTimer = 0;
      let cursorTimer = 0;
      let boxTimer = 0;
      let nudgeTimer = 0;
      let tickTimer = 0;
      let tempActionText = '';
      let wasActive = false;
      let lastSessionStartedAt = 0;

      // -----------------------------------------------------------------------
      // Ardia PowerUp + Halo 慢流速物理光场（WebGL2 + 空心四边几何体裁剪）
      // -----------------------------------------------------------------------
      const VERT_SRC = \`#version 300 es
      in vec2 aPos;
      in vec2 aUv;
      out vec2 vUv;
      void main() {
        vUv = aUv;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }\`;

      const FRAG_SRC = \`#version 300 es
      precision highp float;
      in vec2 vUv;
      out vec4 outColor;

      uniform vec2 uResolution;
      uniform float uTime;
      uniform float uCornerRadius;
      uniform float uGlowSize;
      uniform float uBurstElapsed;
      uniform float uIntroElapsed;
      uniform float uIsDark;
      uniform float uThinking;
      uniform float uStale;

      const float TWO_PI = 6.28318530;

      vec3 haloHash33(vec3 p) {
        vec3 p3 = fract(p * vec3(0.1031, 0.11369, 0.13787));
        p3 += dot(p3, p3.yxz + 19.19);
        return -1.0 + 2.0 * fract((p3.xxy + p3.yzz) * p3.zyx);
      }

      float haloNoise(vec3 p) {
        const float F3 = 0.333333343, G3 = 0.166666672;
        vec3 s = floor(p + (p.x + p.y + p.z) * F3);
        vec3 x = p - s + (s.x + s.y + s.z) * G3;
        vec3 e = step(vec3(0.0), x - x.yzx);
        vec3 i1 = e * (1.0 - e.zxy);
        vec3 i2 = 1.0 - e.zxy * (1.0 - e);
        vec3 x1 = x - i1 + G3;
        vec3 x2 = x - i2 + 2.0 * G3;
        vec3 x3 = x - 0.5;
        vec4 w = max(0.6 - vec4(dot(x,x), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        w = w * w * w * w;
        vec4 d = vec4(dot(x, haloHash33(s)), dot(x1, haloHash33(s + i1)),
                      dot(x2, haloHash33(s + i2)), dot(x3, haloHash33(s + 1.0)));
        return dot(vec4(31.316), d * w);
      }

      float ditherTri(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z) - 0.5;
      }

      vec3 srgbToOklab(vec3 c) {
        vec3 lin = pow(max(c, vec3(0.0)), vec3(2.2));
        float l = 0.4122214708 * lin.r + 0.5363325363 * lin.g + 0.0514459929 * lin.b;
        float m = 0.2119034982 * lin.r + 0.6806995451 * lin.g + 0.1073969566 * lin.b;
        float s = 0.0883024619 * lin.r + 0.2817188376 * lin.g + 0.6299787005 * lin.b;
        float l_ = pow(l, 1.0 / 3.0), m_ = pow(m, 1.0 / 3.0), s_ = pow(s, 1.0 / 3.0);
        return vec3(
          0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
          1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
          0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
        );
      }

      vec3 oklabToSrgb(vec3 lab) {
        float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
        float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
        float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
        float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
        vec3 lin = vec3(
           4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        );
        return pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2));
      }

      vec3 sampleDiaSpectrum(float t) {
        vec3 cols[6] = vec3[6](
          vec3(0.012, 0.345, 0.969),
          vec3(0.314, 0.573, 0.780),
          vec3(0.780, 0.740, 0.996),
          vec3(1.000, 0.780, 0.220),
          vec3(0.980, 0.239, 0.114),
          vec3(0.992, 0.080, 0.880)
        );
        float x = fract(t) * 6.0;
        int i0 = int(floor(x)) % 6;
        int i1 = (i0 + 1) % 6;
        float f = smoothstep(0.0, 1.0, fract(x));
        return oklabToSrgb(mix(srgbToOklab(cols[i0]), srgbToOklab(cols[i1]), f));
      }

      float sdRoundedRect(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      void main() {
        vec2 pos = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
        vec2 center = uResolution * 0.5;
        vec2 p = pos - center;
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        vec2 np = (vUv - 0.5) * 2.0;
        np.x *= aspect;

        float bT = uBurstElapsed;
        float burst = (bT >= 0.0 && bT < 2.2) ? exp(-bT * 2.1) : 0.0;

        float introP = clamp(uIntroElapsed / 1.05, 0.0, 1.0);
        float introEase = 1.0 - pow(2.0, -9.0 * introP);

        // 慢流速呼吸：acting 柔和推进，thinking 从容深呼吸
        float tFlow = uTime * mix(0.22, 0.09, uThinking);
        float nz = haloNoise(vec3(np * 0.82, tFlow)) * 0.5 + 0.5;
        float nz2 = haloNoise(vec3(np * 1.85 + 4.2, tFlow * 0.65)) * 0.5 + 0.5;

        float dist = abs(sdRoundedRect(p, center, uCornerRadius));

        // 双对称高光追光弧线（慢速从容环绕）
        float ang = atan(p.y / max(center.y, 1.0), p.x / max(center.x, 1.0));
        if (ang < 0.0) ang += TWO_PI;
        float perim = ang / TWO_PI;
        float sweepPos = fract(uTime * mix(0.085, 0.035, uThinking) + burst * 0.22);
        float dArc1 = abs(fract(perim - sweepPos + 0.5) - 0.5);
        float dArc2 = abs(fract(perim - sweepPos) - 0.5);
        float arc = smoothstep(0.28, 0.0, min(dArc1, dArc2));

        // 物理半影宽光晕 + 锐利高光边缘
        float glowW = uGlowSize * mix(0.76, 1.50, nz) * mix(1.0, 0.72, uThinking) * (1.0 + 0.30 * burst);
        float rimLine = smoothstep(3.0, 0.75, dist) * (0.66 + 0.38 * arc) * mix(1.0, 0.82, uThinking);
        float softPenumbra = pow(smoothstep(glowW * 1.32, 0.0, dist), 2.15) * (0.38 + 0.36 * arc + 0.22 * nz2);

        // 入场顶部柔和 PowerUp 光浪（1.6s 后自然退场并切换至空心四边几何体）
        float powerWash = 0.0;
        if (uIntroElapsed >= 0.0 && uIntroElapsed < 1.6) {
          float pw = uIntroElapsed / 1.6;
          float head = 1.0 - pow(1.0 - pw, 3.0);
          float along = 1.0 - vUv.y;
          float bend = (1.0 - pow(abs(vUv.x - 0.5) + 0.5, 4.0)) * 0.08;
          float edgeMask = smoothstep(head + 0.14, head - 0.18, along + bend);
          powerWash = edgeMask * (1.0 - pw) * 0.22 * (0.7 + 0.3 * nz);
        }

        float specCoord = (vUv.x * 0.6 + vUv.y * 0.4) + uTime * mix(0.036, 0.015, uThinking) + (nz - 0.5) * 0.28;
        vec3 col = sampleDiaSpectrum(specCoord);
        col = mix(col, vec3(0.98, 0.64, 0.12) * (0.86 + 0.28 * nz), uStale);
        col = mix(col, min(col + 0.34, vec3(1.0)), rimLine * arc * 0.62);
        col = clamp(col + ditherTri(pos + uTime * 30.0) * 0.012, 0.0, 1.0);

        float intensity = clamp(rimLine + softPenumbra + powerWash, 0.0, 1.0);
        float alpha = intensity * introEase * mix(0.90, 0.96, uIsDark);
        outColor = vec4(col * alpha, alpha);
      }\`;

      /** 构建空心四边条带顶点（稳态跳过中心 ~80% 网页区域，零片元着色开销）。 */
      function buildHollowBorderGeometry(pixelW, pixelH, bandPx) {
        const tx = Math.min(bandPx / Math.max(pixelW, 1), 0.5);
        const ty = Math.min(bandPx / Math.max(pixelH, 1), 0.5);
        const verts = [];
        const pushQuad = (u0, v0, u1, v1) => {
          const x0 = u0 * 2 - 1, y0 = v0 * 2 - 1, x1 = u1 * 2 - 1, y1 = v1 * 2 - 1;
          verts.push(
            x0, y0, u0, v0,  x1, y0, u1, v0,  x0, y1, u0, v1,
            x0, y1, u0, v1,  x1, y0, u1, v0,  x1, y1, u1, v1
          );
        };
        if (tx >= 0.48 || ty >= 0.48) {
          pushQuad(0, 0, 1, 1);
        } else {
          pushQuad(0, 0, 1, ty);
          pushQuad(0, 1 - ty, 1, 1);
          pushQuad(0, ty, tx, 1 - ty);
          pushQuad(1 - tx, ty, 1, 1 - ty);
        }
        return new Float32Array(verts);
      }

      const gl = canvas ? canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true }) : null;
      let rendererKind = 'css';
      let prog = null;
      let fullVao = null;
      let hollowVao = null;
      let hollowBuf = null;
      let hollowVertCount = 6;
      const uniforms = {};

      if (gl) {
        try {
          const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
            return sh;
          };
          prog = gl.createProgram();
          gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
          gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
          gl.linkProgram(prog);
          if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
          gl.useProgram(prog);
          const aPos = gl.getAttribLocation(prog, 'aPos');
          const aUv = gl.getAttribLocation(prog, 'aUv');

          const bindAttribs = (vao, buf, data, usage) => {
            gl.bindVertexArray(vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, data, usage);
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
            gl.enableVertexAttribArray(aUv);
            gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
          };

          fullVao = gl.createVertexArray();
          const fullBuf = gl.createBuffer();
          bindAttribs(
            fullVao,
            fullBuf,
            new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1]),
            gl.STATIC_DRAW
          );

          hollowVao = gl.createVertexArray();
          hollowBuf = gl.createBuffer();
          const initHollow = buildHollowBorderGeometry(800, 600, 120);
          hollowVertCount = initHollow.length / 4;
          bindAttribs(hollowVao, hollowBuf, initHollow, gl.DYNAMIC_DRAW);

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

          const uNames = [
            'uResolution', 'uTime', 'uCornerRadius', 'uGlowSize',
            'uBurstElapsed', 'uIntroElapsed', 'uIsDark', 'uThinking', 'uStale'
          ];
          for (const n of uNames) uniforms[n] = gl.getUniformLocation(prog, n);
          rendererKind = 'webgl2';
        } catch {
          rendererKind = 'css';
        }
      }
      document.body.dataset.renderer = rendererKind;

      let rafId = 0;
      let lastTickAt = 0;
      let lastDrawAt = 0;
      let shaderTime = 0;
      let introElapsed = 0;
      let burstElapsed = -1;
      let thinkingBlend = 0;
      let staleBlend = 0;

      const syncCanvasSize = () => {
        if (rendererKind !== 'webgl2' || !gl) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(window.innerWidth * dpr));
        const h = Math.max(1, Math.round(window.innerHeight * dpr));
        if (canvas.width === w && canvas.height === h) return;
        canvas.width = w;
        canvas.height = h;
        const hollow = buildHollowBorderGeometry(w, h, Math.ceil(118 * dpr));
        hollowVertCount = hollow.length / 4;
        gl.bindBuffer(gl.ARRAY_BUFFER, hollowBuf);
        gl.bufferData(gl.ARRAY_BUFFER, hollow, gl.DYNAMIC_DRAW);
      };

      const renderGlFrame = (dt) => {
        if (rendererKind !== 'webgl2' || !gl || !prog) return;
        syncCanvasSize();
        const w = canvas.width;
        const h = canvas.height;
        if (w < 4 || h < 4) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const wantThinking = state.phase === 'thinking' ? 1 : 0;
        const wantStale = isStale() ? 1 : 0;
        shaderTime += dt;
        introElapsed += dt;
        if (burstElapsed >= 0) burstElapsed += dt;
        thinkingBlend += (wantThinking - thinkingBlend) * Math.min(1, dt * 3.8 + (dt === 0 ? 1 : 0));
        staleBlend += (wantStale - staleBlend) * Math.min(1, dt * 3.8 + (dt === 0 ? 1 : 0));

        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(prog);
        gl.uniform2f(uniforms.uResolution, w, h);
        gl.uniform1f(uniforms.uTime, shaderTime);
        gl.uniform1f(uniforms.uCornerRadius, 10.0 * dpr);
        gl.uniform1f(uniforms.uGlowSize, 42.0 * dpr);
        gl.uniform1f(uniforms.uBurstElapsed, burstElapsed);
        gl.uniform1f(uniforms.uIntroElapsed, introElapsed);
        gl.uniform1f(uniforms.uIsDark, state.theme === 'dark' ? 1.0 : 0.0);
        gl.uniform1f(uniforms.uThinking, thinkingBlend);
        gl.uniform1f(uniforms.uStale, staleBlend);

        if (introElapsed < INTRO_FULLSCREEN_SEC) {
          gl.bindVertexArray(fullVao);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        } else {
          gl.bindVertexArray(hollowVao);
          gl.drawArrays(gl.TRIANGLES, 0, hollowVertCount);
        }
      };

      const stopLoop = () => {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      };

      const loop = (now) => {
        rafId = 0;
        if (document.body.dataset.animate !== 'true') return;
        const minInterval = state.phase === 'thinking' && burstElapsed < 0 ? 40 : 22;
        if (now - lastDrawAt >= minInterval) {
          const dt = Math.min(0.06, lastTickAt > 0 ? (now - lastTickAt) / 1000 : 0.016);
          lastTickAt = now;
          lastDrawAt = now;
          renderGlFrame(dt);
        }
        rafId = requestAnimationFrame(loop);
      };

      const formatElapsed = (ms) => {
        const total = Math.max(0, Math.floor(ms / 1000));
        const m = String(Math.floor(total / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        return m + ':' + s;
      };

      const isStale = () =>
        state.mode === 'agent' &&
        state.lastActivityAt > 0 &&
        Date.now() - state.lastActivityAt >= STALE_MS;

      const syncAnimate = () => {
        const reduced = Boolean(motionQuery && motionQuery.matches);
        const active = Boolean(state.attached && state.visible && state.mode === 'agent' && !document.hidden);
        const animate = active && !reduced;
        document.body.dataset.animate = animate ? 'true' : 'false';
        if (animate && rendererKind === 'webgl2') {
          if (!rafId) {
            lastTickAt = performance.now();
            lastDrawAt = 0;
            rafId = requestAnimationFrame(loop);
          }
        } else {
          stopLoop();
          if (active && reduced && rendererKind === 'webgl2') {
            introElapsed = 2.0;
            renderGlFrame(0);
          } else if (!active && rendererKind === 'webgl2' && gl) {
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
          }
        }
      };

      const syncChip = () => {
        const active = state.attached && state.visible && state.mode === 'agent';
        const show = active && state.showControlPill;
        statusChip.classList.toggle('hidden', !show);
        const stale = isStale();
        document.body.dataset.stale = stale ? 'true' : 'false';
        document.body.dataset.phase = state.phase || 'acting';
        if (stale) {
          statusLabel.textContent = state.caller + ' · 暂无响应，点此结束';
        } else if (tempActionText) {
          statusLabel.textContent = state.caller + ' · ' + tempActionText;
        } else if (state.phase === 'thinking') {
          statusLabel.textContent = state.caller + ' 思考中 · 托管常驻';
        } else {
          statusLabel.textContent = state.caller + ' 执行中';
        }
        statusTimer.textContent = state.startedAt > 0 ? formatElapsed(Date.now() - state.startedAt) : '00:00';
      };

      const syncTicker = () => {
        const shouldTick = state.attached && state.visible && state.mode === 'agent';
        if (shouldTick && !tickTimer) {
          tickTimer = setInterval(syncChip, 1000);
        } else if (!shouldTick && tickTimer) {
          clearInterval(tickTimer);
          tickTimer = 0;
        }
      };

      const hideTraces = () => {
        cursor.style.opacity = '0';
        targetBox.style.opacity = '0';
        targetTag.style.opacity = '0';
        nudge.classList.remove('show');
        tempActionText = '';
      };

      window.__warrenShieldState = (next) => {
        Object.assign(state, next || {});
        document.body.dataset.mode = state.mode;
        document.body.dataset.theme = state.theme;
        document.body.dataset.phase = state.phase || 'acting';
        const nowActive = Boolean(state.attached && state.visible && state.mode === 'agent');
        const newSession = state.startedAt > 0 && state.startedAt !== lastSessionStartedAt;
        if (nowActive && (!wasActive || newSession)) {
          introElapsed = 0;
          lastSessionStartedAt = state.startedAt;
        }
        wasActive = nowActive;
        syncChip();
        syncAnimate();
        syncTicker();
        if (!nowActive) hideTraces();
      };

      window.__warrenShieldAction = (act) => {
        if (!act || state.mode !== 'agent') return;
        const x = Number(act.x);
        const y = Number(act.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        state.lastActivityAt = Date.now();
        state.phase = 'acting';
        burstElapsed = 0;
        const nearBottomCenter =
          y > Math.max(120, window.innerHeight - 104) &&
          Math.abs(x - window.innerWidth / 2) < 230;
        statusChip.classList.toggle('dodge-top', nearBottomCenter);
        tempActionText = act.label || act.kind;
        syncChip();
        clearTimeout(chipTimer);
        chipTimer = setTimeout(() => {
          tempActionText = '';
          if (state.mode === 'agent') syncChip();
        }, 2600);

        const hasRect = act.rect && act.rect.width > 0 && act.rect.height > 0;
        const cx = hasRect && act.kind === 'fill' ? act.rect.x + act.rect.width - 4 : x;
        const cy = hasRect && act.kind === 'fill' ? act.rect.y + act.rect.height - 2 : y;
        cursor.style.left = cx + 'px';
        cursor.style.top = cy + 'px';
        cursor.style.opacity = '1';
        if (act.kind === 'click') {
          cursor.classList.remove('clicking');
          void cursor.offsetWidth;
          cursor.classList.add('clicking');
        }
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => { cursor.style.opacity = state.mode === 'agent' ? '0.45' : '0'; }, 2600);

        if (hasRect) {
          const rx = Math.max(0, act.rect.x - 4);
          const ry = Math.max(0, act.rect.y - 4);
          targetBox.style.left = rx + 'px';
          targetBox.style.top = ry + 'px';
          targetBox.style.width = (act.rect.width + 8) + 'px';
          targetBox.style.height = (act.rect.height + 8) + 'px';
          targetBox.style.opacity = '1';
          targetTag.textContent = act.label || act.kind;
          targetTag.style.left = Math.min(rx, Math.max(8, window.innerWidth - 200)) + 'px';
          targetTag.style.top = Math.max(6, ry - 25) + 'px';
          targetTag.style.opacity = '1';
          clearTimeout(boxTimer);
          boxTimer = setTimeout(() => {
            targetBox.style.opacity = '0';
            targetTag.style.opacity = '0';
          }, 1900);
        }

        if (act.kind === 'click') {
          ripple.style.left = x + 'px';
          ripple.style.top = y + 'px';
          ripple.classList.remove('pop');
          void ripple.offsetWidth;
          ripple.classList.add('pop');
        }
      };

      window.__warrenShieldStats = () => ({
        renderer: rendererKind,
        mode: state.mode,
        theme: state.theme,
        phase: state.phase,
        stale: document.body.dataset.stale === 'true',
        attached: state.attached,
        visible: state.visible,
        animate: document.body.dataset.animate === 'true',
      });

      window.addEventListener('resize', () => {
        syncCanvasSize();
        if (rendererKind === 'webgl2' && state.attached && state.visible && state.mode === 'agent') {
          renderGlFrame(0);
        }
      });
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
          syncCanvasSize();
        }).observe(document.documentElement);
      }
      document.addEventListener('visibilitychange', syncAnimate);
      if (motionQuery && typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', syncAnimate);
      }

      // 即使关闭底部控制胶囊，误点遮罩仍给出明确的非阻塞提示，杜绝「静默吞点击」黑洞
      catchEl.addEventListener('pointerdown', (event) => {
        if (state.showControlPill) {
          const phaseLabel = state.phase === 'thinking' ? '思考中' : '执行中';
          nudgeText.textContent = state.caller + ' 托管' + phaseLabel;
          nudgeTakeover.classList.remove('hidden');
          nudgeFinish.classList.remove('hidden');
        } else {
          nudgeText.textContent = state.caller + ' 正在操作 · 点击顶栏「接管」可暂停';
          nudgeTakeover.classList.add('hidden');
          nudgeFinish.classList.add('hidden');
        }
        const left = Math.min(Math.max(event.clientX, 160), Math.max(160, window.innerWidth - 160));
        const top = Math.max(event.clientY, 48);
        nudge.style.left = left + 'px';
        nudge.style.top = top + 'px';
        nudge.classList.add('show');
        clearTimeout(nudgeTimer);
        nudgeTimer = setTimeout(() => { nudge.classList.remove('show'); }, 2200);
      });
    })();
  </script>
</body></html>`;
}
