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
 * 构建流体棱镜光场 + 精密光学 HUD 透明护盾文档（100% 纯 CSS GPU 合成，零 WebGL、零 rAF）：
 * - 边缘 2px `@property --prism-angle` 流体棱镜光环 + 柔焦内缘折射光晕 + 顶部光学扫描线 + 四角光学定位标；
 * - 双节律状态机：`acting`（高速流动 + 扫描光）↔ `thinking`（缓速呼吸，常驻不闪烁）↔ `stale`（≥5 分钟无响应温琥珀提醒）；
 * - 底部居中悬浮玻璃态 HUD 胶囊：棱镜核 + 实时阶段/动作 + 计时器 +「接管」/「结束」双按钮，自动避让目标操作区；
 * - 即使关闭底部控制胶囊（`showControlPill === false`），误点遮罩仍闪出非阻塞提示，杜绝静默吞点击。
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
    --prism-c1: #4f7cff;
    --prism-c2: #38bdf8;
    --prism-c3: #a855f7;
    --prism-c4: #e0f2fe;
    --prism-c5: #6366f1;
    --hud-bg: rgba(15, 19, 28, 0.86);
    --hud-border: rgba(125, 175, 255, 0.34);
    --hud-fg: #f1f5f9;
    --hud-muted: rgba(203, 213, 225, 0.72);
    --hud-shadow: 0 10px 30px rgba(2, 6, 23, 0.44), 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
    --reticle-color: rgba(103, 232, 249, 0.78);
    --reticle-glow: rgba(56, 189, 248, 0.45);
    --btn-takeover-bg: rgba(79, 124, 255, 0.22);
    --btn-takeover-bg-hover: rgba(79, 124, 255, 0.36);
    --btn-takeover-fg: #bae6fd;
    --btn-takeover-border: rgba(96, 165, 250, 0.48);
    --btn-finish-bg: rgba(148, 163, 184, 0.14);
    --btn-finish-bg-hover: rgba(248, 113, 113, 0.22);
    --btn-finish-fg: #cbd5e1;
    --btn-finish-fg-hover: #fecaca;
    --btn-finish-border: rgba(148, 163, 184, 0.28);
  }
  body[data-theme="light"] {
    --prism-c1: #3b5bdb;
    --prism-c2: #0284c7;
    --prism-c3: #7c3aed;
    --prism-c4: #bae6fd;
    --prism-c5: #4f46e5;
    --hud-bg: rgba(255, 255, 255, 0.9);
    --hud-border: rgba(59, 91, 219, 0.28);
    --hud-fg: #0f172a;
    --hud-muted: rgba(71, 85, 105, 0.8);
    --hud-shadow: 0 10px 28px rgba(15, 23, 42, 0.14), 0 0 0 1px rgba(255, 255, 255, 0.85) inset;
    --reticle-color: rgba(37, 99, 235, 0.68);
    --reticle-glow: rgba(59, 130, 246, 0.28);
    --btn-takeover-bg: rgba(59, 91, 219, 0.12);
    --btn-takeover-bg-hover: rgba(59, 91, 219, 0.2);
    --btn-takeover-fg: #2b4acb;
    --btn-takeover-border: rgba(59, 91, 219, 0.34);
    --btn-finish-bg: rgba(15, 23, 42, 0.05);
    --btn-finish-bg-hover: rgba(220, 38, 38, 0.12);
    --btn-finish-fg: #475569;
    --btn-finish-fg-hover: #b91c1c;
    --btn-finish-border: rgba(15, 23, 42, 0.14);
  }
  body[data-stale="true"] {
    --prism-c1: #f59e0b;
    --prism-c2: #fbbf24;
    --prism-c3: #f97316;
    --prism-c4: #fef3c7;
    --prism-c5: #d97706;
    --hud-border: rgba(245, 158, 11, 0.48);
    --reticle-color: rgba(251, 191, 36, 0.72);
    --reticle-glow: rgba(245, 158, 11, 0.38);
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

  /* 柔焦边缘环境折射光晕（保持中心 >94% 视口完全通透） */
  #aura {
    position: fixed; inset: 0; pointer-events: none; border-radius: 10px; z-index: 2;
    box-shadow:
      inset 0 0 24px rgba(56, 189, 248, 0.18),
      inset 0 0 56px rgba(124, 58, 237, 0.1);
    transition: opacity 0.35s ease, box-shadow 0.4s ease;
  }
  body[data-theme="light"] #aura {
    box-shadow:
      inset 0 0 20px rgba(37, 99, 235, 0.12),
      inset 0 0 46px rgba(124, 58, 237, 0.06);
  }
  body[data-phase="thinking"] #aura {
    box-shadow:
      inset 0 0 18px rgba(79, 124, 255, 0.14),
      inset 0 0 42px rgba(99, 102, 241, 0.07);
  }
  body[data-stale="true"] #aura {
    box-shadow:
      inset 0 0 22px rgba(245, 158, 11, 0.18),
      inset 0 0 48px rgba(249, 115, 22, 0.08);
  }

  /* 流体棱镜光环：2px 锐利动态绕边色散框 + 柔化内散光带 */
  #prism-ring, #prism-glow {
    position: fixed; inset: 0; pointer-events: none; border-radius: 10px;
    background: conic-gradient(
      from var(--prism-angle),
      var(--prism-c1) 0deg,
      var(--prism-c2) 72deg,
      var(--prism-c4) 118deg,
      var(--prism-c3) 186deg,
      var(--prism-c5) 262deg,
      var(--prism-c2) 320deg,
      var(--prism-c1) 360deg
    );
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    transition: opacity 0.35s ease;
  }
  #prism-ring {
    z-index: 3;
    padding: 2px;
    opacity: 0.94;
  }
  #prism-glow {
    z-index: 2;
    padding: 8px;
    filter: blur(8px);
    opacity: 0.42;
  }
  body[data-theme="light"] #prism-glow { opacity: 0.24; }
  body[data-phase="thinking"] #prism-ring { opacity: 0.72; }
  body[data-phase="thinking"] #prism-glow { opacity: 0.26; }

  /* 顶部光学能量扫描线 */
  #sweep {
    position: fixed; top: 0; left: 8px; right: 8px; height: 2px; z-index: 4;
    pointer-events: none; border-radius: 999px;
    background: linear-gradient(90deg, transparent 0%, var(--prism-c1) 24%, var(--prism-c4) 50%, var(--prism-c2) 76%, transparent 100%);
    background-size: 38% 100%; background-repeat: no-repeat;
    box-shadow: 0 0 12px var(--reticle-glow);
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  /* 四角精密光学定位标 */
  .corner-mark {
    position: fixed; width: 13px; height: 13px; z-index: 4; pointer-events: none;
    border-color: var(--reticle-color);
    border-style: solid;
    border-width: 0;
    filter: drop-shadow(0 0 5px var(--reticle-glow));
    opacity: 0.84;
    transition: opacity 0.3s ease, border-color 0.3s ease;
  }
  .corner-mark.tl { top: 10px; left: 10px; border-top-width: 1.5px; border-left-width: 1.5px; border-top-left-radius: 3px; }
  .corner-mark.tr { top: 10px; right: 10px; border-top-width: 1.5px; border-right-width: 1.5px; border-top-right-radius: 3px; }
  .corner-mark.bl { bottom: 10px; left: 10px; border-bottom-width: 1.5px; border-left-width: 1.5px; border-bottom-left-radius: 3px; }
  .corner-mark.br { bottom: 10px; right: 10px; border-bottom-width: 1.5px; border-right-width: 1.5px; border-bottom-right-radius: 3px; }
  body[data-phase="thinking"] .corner-mark { opacity: 0.46; }

  /* 双节律 GPU 合成动画：acting 高频脉冲 vs thinking 舒缓呼吸 */
  body[data-animate="true"] #prism-ring,
  body[data-animate="true"] #prism-glow {
    animation: warren-prism-spin 4.2s linear infinite;
  }
  body[data-animate="true"][data-phase="thinking"] #prism-ring,
  body[data-animate="true"][data-phase="thinking"] #prism-glow {
    animation: warren-prism-spin 11s linear infinite;
  }
  body[data-animate="true"][data-stale="true"] #prism-ring,
  body[data-animate="true"][data-stale="true"] #prism-glow {
    animation: warren-prism-spin 14s linear infinite;
  }
  body[data-animate="true"] #sweep {
    opacity: 0.94;
    animation: warren-sweep 2.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  body[data-animate="true"][data-phase="thinking"] #sweep {
    opacity: 0.32;
    animation: warren-sweep 5.4s ease-in-out infinite;
  }
  body[data-animate="true"][data-stale="true"] #sweep { opacity: 0.24; }
  body[data-animate="true"] #aura {
    animation: warren-breathe 3s ease-in-out infinite;
  }
  body[data-animate="true"][data-phase="thinking"] #aura {
    animation: warren-breathe 5.6s ease-in-out infinite;
  }
  body[data-animate="true"] .corner-mark {
    animation: warren-reticle 2.6s ease-in-out infinite;
  }
  body[data-animate="true"][data-phase="thinking"] .corner-mark {
    animation: warren-reticle 5.6s ease-in-out infinite;
  }

  @keyframes warren-prism-spin {
    from { --prism-angle: 0deg; }
    to { --prism-angle: 360deg; }
  }
  @keyframes warren-sweep {
    0% { background-position: -60% 0; }
    100% { background-position: 160% 0; }
  }
  @keyframes warren-breathe {
    0%, 100% { opacity: 0.78; }
    50% { opacity: 1; }
  }
  @keyframes warren-reticle {
    0%, 100% { opacity: 0.56; }
    50% { opacity: 0.96; }
  }
  @keyframes warren-orb-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes warren-scanline {
    0% { transform: translateY(-100%); opacity: 0; }
    20% { opacity: 0.75; }
    80% { opacity: 0.75; }
    100% { transform: translateY(400%); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    #prism-ring, #prism-glow, #sweep, #aura, .corner-mark, #status-orb::before { animation: none !important; }
    #sweep { opacity: 0.5; background-position: 50% 0; }
  }

  /* 光学目标锁定框与激光微扫 */
  #target-box {
    position: fixed; z-index: 5; pointer-events: none; opacity: 0; overflow: hidden;
    border: 1.5px solid rgba(56, 189, 248, 0.92);
    background: rgba(56, 189, 248, 0.08);
    box-shadow: 0 0 0 1px rgba(168, 85, 247, 0.25), 0 0 16px rgba(56, 189, 248, 0.28);
    border-radius: 7px;
    transition: opacity 0.16s ease, left 0.12s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.12s cubic-bezier(0.2, 0.8, 0.2, 1), width 0.12s ease, height 0.12s ease;
  }
  #target-box::after {
    content: ''; position: absolute; left: 0; right: 0; top: 0; height: 28%;
    background: linear-gradient(180deg, transparent, rgba(125, 211, 252, 0.28), transparent);
    animation: warren-scanline 1.1s ease-in-out infinite;
  }
  #target-tag {
    position: fixed; z-index: 6; pointer-events: none; opacity: 0;
    padding: 2px 8px; border-radius: 6px;
    background: rgba(15, 23, 42, 0.9); color: #e0f2fe;
    border: 1px solid rgba(56, 189, 248, 0.48);
    box-shadow: 0 4px 12px rgba(2, 6, 23, 0.35);
    font: 500 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: opacity 0.16s ease;
  }
  #cursor {
    position: fixed; z-index: 7; pointer-events: none; opacity: 0;
    width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 999px;
    background: radial-gradient(circle at 35% 35%, #ffffff 0%, #7dd3fc 42%, #4f7cff 100%);
    border: 1.5px solid rgba(255, 255, 255, 0.96);
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.28), 0 0 14px rgba(56, 189, 248, 0.72);
    transition: left 0.14s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.14s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s ease;
  }
  #ripple {
    position: fixed; z-index: 6; pointer-events: none; opacity: 0;
    width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 999px;
    border: 1.5px solid rgba(56, 189, 248, 0.92);
    box-shadow: 0 0 12px rgba(56, 189, 248, 0.45);
  }
  #ripple::after {
    content: ''; position: absolute; inset: -5px; border-radius: 999px;
    border: 1px solid rgba(168, 85, 247, 0.7);
    opacity: 0;
  }
  #ripple.pop { animation: warren-ripple 0.52s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  #ripple.pop::after { animation: warren-ripple-outer 0.56s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  @keyframes warren-ripple {
    0% { opacity: 0.96; transform: scale(0.32); }
    100% { opacity: 0; transform: scale(1.85); }
  }
  @keyframes warren-ripple-outer {
    0% { opacity: 0.75; transform: scale(0.45); }
    100% { opacity: 0; transform: scale(2.25); }
  }

  /* 底部居中悬浮精密玻璃 HUD 胶囊 */
  #status-chip {
    position: fixed; left: 50%; bottom: 16px; z-index: 8;
    transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px;
    padding: 5px 6px 5px 10px; border-radius: 999px;
    background: var(--hud-bg); color: var(--hud-fg);
    border: 1px solid var(--hud-border);
    box-shadow: var(--hud-shadow);
    backdrop-filter: blur(16px) saturate(1.4);
    -webkit-backdrop-filter: blur(16px) saturate(1.4);
    transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.22s ease, bottom 0.22s ease;
    max-width: calc(100vw - 32px);
  }
  #status-chip.hidden { opacity: 0; pointer-events: none; transform: translate(-50%, 8px); }
  #status-chip.dodge-top { bottom: auto; top: 14px; }
  #status-orb {
    position: relative; width: 14px; height: 14px; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
  }
  #status-orb::before {
    content: ''; position: absolute; inset: 0; border-radius: 999px;
    background: conic-gradient(from 0deg, var(--prism-c1), var(--prism-c2), var(--prism-c3), var(--prism-c1));
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
    animation: warren-orb-spin 2.2s linear infinite;
  }
  body[data-phase="thinking"] #status-orb::before { animation-duration: 5.5s; opacity: 0.78; }
  body[data-animate="false"] #status-orb::before { animation-play-state: paused; }
  #status-dot {
    width: 5px; height: 5px; border-radius: 999px;
    background: var(--prism-c2);
    box-shadow: 0 0 8px var(--prism-c2);
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
    width: 1px; height: 13px; background: var(--hud-border); flex: none; opacity: 0.7;
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
    backdrop-filter: blur(14px);
    opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
    white-space: nowrap;
  }
  #nudge.show { opacity: 1; pointer-events: auto; }
  .hidden { display: none !important; }
</style></head>
<body data-mode="agent" data-theme="dark" data-phase="acting" data-stale="false" data-animate="false">
  <div id="catch"></div>
  <div id="aura"></div>
  <div id="prism-glow"></div>
  <div id="prism-ring"></div>
  <div id="sweep"></div>
  <div class="corner-mark tl"></div>
  <div class="corner-mark tr"></div>
  <div class="corner-mark bl"></div>
  <div class="corner-mark br"></div>
  <div id="target-box"></div>
  <div id="target-tag"></div>
  <div id="cursor"></div>
  <div id="ripple"></div>
  <div id="status-chip" class="hidden">
    <span id="status-orb"><span id="status-dot"></span></span>
    <span id="status-label">Agent 操作中</span>
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
        const animate = Boolean(state.attached && state.visible && state.mode === 'agent' && !reduced && !document.hidden);
        document.body.dataset.animate = animate ? 'true' : 'false';
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
        syncChip();
        syncAnimate();
        syncTicker();
        if (state.mode !== 'agent' || !state.attached || !state.visible) hideTraces();
      };

      window.__warrenShieldAction = (act) => {
        if (!act || state.mode !== 'agent') return;
        const x = Number(act.x);
        const y = Number(act.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        state.lastActivityAt = Date.now();
        state.phase = 'acting';
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
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => { cursor.style.opacity = state.mode === 'agent' ? '0.42' : '0'; }, 2400);

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
        mode: state.mode,
        theme: state.theme,
        phase: state.phase,
        stale: document.body.dataset.stale === 'true',
        attached: state.attached,
        visible: state.visible,
        animate: document.body.dataset.animate === 'true',
      });

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
