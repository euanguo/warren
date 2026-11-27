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

/** 仅当遮罩挂载、窗口/舞台可见、处于 Agent 控制态且系统未开启减弱动画时启用动态光效。 */
export function shouldShieldAnimate(input: ShieldAnimationInput): boolean {
  return Boolean(input.attached && input.visible && input.mode === 'agent' && !input.reducedMotion && !input.hidden);
}

/**
 * 构建轻量纯 CSS `InputShield` 文档（零 WebGL 上下文、零 rAF 轮询）：
 * - 仅在 Agent 实际持有租约控制页面时挂载，空闲 Agent Space 完全不拦用户输入；
 * - 使用纯 CSS 边缘呼吸光晕 + 顶部细流光 + 元素锚框/点击波纹；
 * - 即使关闭底部控制胶囊（`showControlPill === false`），误点遮罩也会闪出非阻塞提示，不再静默吃点击。
 */
export function buildShieldHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
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
    border-radius: 8px;
  }
  #aura {
    position: fixed; inset: 0; pointer-events: none; border-radius: 8px; z-index: 2;
    box-shadow:
      inset 0 0 0 2px rgba(91, 140, 255, 0.88),
      inset 0 0 22px rgba(56, 189, 248, 0.22);
    transition: opacity 0.18s ease, box-shadow 0.2s ease;
  }
  body[data-theme="light"] #aura {
    box-shadow:
      inset 0 0 0 2px rgba(59, 91, 219, 0.86),
      inset 0 0 18px rgba(37, 99, 235, 0.16);
  }
  #sweep {
    position: fixed; top: 0; left: 0; right: 0; height: 2.5px; z-index: 3;
    pointer-events: none; border-radius: 8px 8px 0 0;
    background: linear-gradient(90deg, transparent 0%, #5b8cff 38%, #38bdf8 66%, transparent 100%);
    background-size: 42% 100%; background-repeat: no-repeat;
    box-shadow: 0 1px 10px rgba(91, 140, 255, 0.45);
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  body[data-theme="light"] #sweep {
    background: linear-gradient(90deg, transparent 0%, #3b5bdb 38%, #0284c7 66%, transparent 100%);
    box-shadow: 0 1px 8px rgba(59, 91, 219, 0.32);
  }
  body[data-animate="true"] #sweep {
    opacity: 0.96;
    animation: warren-sweep 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  body[data-animate="true"] #aura {
    animation: warren-breathe 3.2s ease-in-out infinite;
  }
  @keyframes warren-sweep {
    0% { background-position: -65% 0; }
    100% { background-position: 165% 0; }
  }
  @keyframes warren-breathe {
    0%, 100% { opacity: 0.84; }
    50% { opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    #sweep, #aura { animation: none !important; }
    #sweep { opacity: 0.65; background-position: 50% 0; }
  }
  #target-box {
    position: fixed; z-index: 4; pointer-events: none; opacity: 0;
    border: 1.5px solid rgba(91, 140, 255, 0.92);
    background: rgba(91, 140, 255, 0.1);
    border-radius: 6px;
    transition: opacity 0.16s ease, left 0.12s ease, top 0.12s ease, width 0.12s ease, height 0.12s ease;
  }
  #target-tag {
    position: fixed; z-index: 5; pointer-events: none; opacity: 0;
    padding: 2px 7px; border-radius: 5px;
    background: rgba(15, 23, 42, 0.88); color: #e2e8f0;
    border: 1px solid rgba(91, 140, 255, 0.45);
    font: 500 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: opacity 0.16s ease;
  }
  #cursor {
    position: fixed; z-index: 6; pointer-events: none; opacity: 0;
    width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 999px;
    background: #5b8cff; border: 2px solid #ffffff;
    box-shadow: 0 0 0 3px rgba(91, 140, 255, 0.28), 0 2px 8px rgba(15, 23, 42, 0.4);
    transition: left 0.14s ease-out, top 0.14s ease-out, opacity 0.22s ease;
  }
  #ripple {
    position: fixed; z-index: 5; pointer-events: none; opacity: 0;
    width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 999px;
    border: 2px solid rgba(56, 189, 248, 0.9);
  }
  #ripple.pop { animation: warren-ripple 0.48s ease-out forwards; }
  @keyframes warren-ripple {
    0% { opacity: 0.95; transform: scale(0.35); }
    100% { opacity: 0; transform: scale(1.75); }
  }
  #status-chip {
    position: fixed; right: 14px; bottom: 14px; z-index: 7;
    display: flex; align-items: center; gap: 8px;
    padding: 5px 7px 5px 11px; border-radius: 999px;
    background: rgba(17, 20, 27, 0.88); color: #f1f5f9;
    border: 1px solid rgba(91, 140, 255, 0.45);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(10px);
    transition: opacity 0.18s ease, transform 0.18s ease;
  }
  body[data-theme="light"] #status-chip {
    background: rgba(255, 255, 255, 0.92); color: #0f172a;
    border-color: rgba(59, 91, 219, 0.35);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
  }
  #status-chip.hidden { opacity: 0; pointer-events: none; transform: translateY(6px); }
  #status-chip.dodge-left { right: auto; left: 14px; }
  #status-dot {
    width: 7px; height: 7px; border-radius: 999px; background: #5b8cff; flex: none;
  }
  #status-label { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .takeover-btn {
    display: inline-flex; align-items: center; padding: 2px 9px; border-radius: 999px;
    background: rgba(91, 140, 255, 0.2); color: #93c5fd; text-decoration: none;
    border: 1px solid rgba(91, 140, 255, 0.45); font-weight: 500; font-size: 11px;
    cursor: pointer;
  }
  body[data-theme="light"] .takeover-btn {
    background: rgba(59, 91, 219, 0.12); color: #3b5bdb; border-color: rgba(59, 91, 219, 0.35);
  }
  .takeover-btn:hover { background: rgba(91, 140, 255, 0.32); }
  #nudge {
    position: fixed; z-index: 8; transform: translate(-50%, -115%);
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; border-radius: 999px;
    background: rgba(17, 20, 27, 0.92); color: #f8fafc;
    border: 1px solid rgba(148, 163, 184, 0.35);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.36);
    opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
    white-space: nowrap;
  }
  body[data-theme="light"] #nudge {
    background: rgba(255, 255, 255, 0.96); color: #0f172a;
    border-color: rgba(15, 23, 42, 0.16);
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.14);
  }
  #nudge.show { opacity: 1; pointer-events: auto; }
  #nudge-action.hidden { display: none; }
</style></head>
<body data-mode="agent" data-theme="dark" data-animate="false">
  <div id="catch"></div>
  <div id="aura"></div>
  <div id="sweep"></div>
  <div id="target-box"></div>
  <div id="target-tag"></div>
  <div id="cursor"></div>
  <div id="ripple"></div>
  <div id="status-chip" class="hidden">
    <span id="status-dot"></span>
    <span id="status-label">Agent 操作中</span>
    <a class="takeover-btn" href="warren-action://takeover">接管</a>
  </div>
  <div id="nudge">
    <span id="nudge-text">Agent 正在操作</span>
    <a id="nudge-action" class="takeover-btn" href="warren-action://takeover">接管</a>
  </div>
  <script>
    (() => {
      const state = {
        caller: 'Agent',
        mode: 'idle',
        theme: 'dark',
        showControlPill: true,
        attached: false,
        visible: false,
      };
      const catchEl = document.getElementById('catch');
      const statusChip = document.getElementById('status-chip');
      const statusLabel = document.getElementById('status-label');
      const targetBox = document.getElementById('target-box');
      const targetTag = document.getElementById('target-tag');
      const cursor = document.getElementById('cursor');
      const ripple = document.getElementById('ripple');
      const nudge = document.getElementById('nudge');
      const nudgeText = document.getElementById('nudge-text');
      const nudgeAction = document.getElementById('nudge-action');
      const motionQuery = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      let chipTimer = 0;
      let cursorTimer = 0;
      let boxTimer = 0;
      let nudgeTimer = 0;

      const syncAnimate = () => {
        const reduced = Boolean(motionQuery && motionQuery.matches);
        const animate = Boolean(state.attached && state.visible && state.mode === 'agent' && !reduced && !document.hidden);
        document.body.dataset.animate = animate ? 'true' : 'false';
      };

      const syncChip = (actionText) => {
        const show = state.attached && state.visible && state.mode === 'agent' && state.showControlPill;
        statusChip.classList.toggle('hidden', !show);
        statusLabel.textContent = actionText ? state.caller + ' · ' + actionText : state.caller + ' 操作中';
      };

      const hideTraces = () => {
        cursor.style.opacity = '0';
        targetBox.style.opacity = '0';
        targetTag.style.opacity = '0';
        nudge.classList.remove('show');
      };

      window.__warrenShieldState = (next) => {
        Object.assign(state, next || {});
        document.body.dataset.mode = state.mode;
        document.body.dataset.theme = state.theme;
        syncChip();
        syncAnimate();
        if (state.mode !== 'agent' || !state.attached || !state.visible) hideTraces();
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
        chipTimer = setTimeout(() => { if (state.mode === 'agent') syncChip(); }, 2400);

        const hasRect = act.rect && act.rect.width > 0 && act.rect.height > 0;
        const cx = hasRect && act.kind === 'fill' ? act.rect.x + act.rect.width - 4 : x;
        const cy = hasRect && act.kind === 'fill' ? act.rect.y + act.rect.height - 2 : y;
        cursor.style.left = cx + 'px';
        cursor.style.top = cy + 'px';
        cursor.style.opacity = '1';
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(() => { cursor.style.opacity = state.mode === 'agent' ? '0.45' : '0'; }, 2200);

        if (hasRect) {
          const rx = Math.max(0, act.rect.x - 4);
          const ry = Math.max(0, act.rect.y - 4);
          targetBox.style.left = rx + 'px';
          targetBox.style.top = ry + 'px';
          targetBox.style.width = (act.rect.width + 8) + 'px';
          targetBox.style.height = (act.rect.height + 8) + 'px';
          targetBox.style.opacity = '1';
          targetTag.textContent = act.label || act.kind;
          targetTag.style.left = Math.min(rx, Math.max(8, window.innerWidth - 180)) + 'px';
          targetTag.style.top = Math.max(6, ry - 23) + 'px';
          targetTag.style.opacity = '1';
          clearTimeout(boxTimer);
          boxTimer = setTimeout(() => {
            targetBox.style.opacity = '0';
            targetTag.style.opacity = '0';
          }, 1800);
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
          nudgeText.textContent = state.caller + ' 正在操作';
          nudgeAction.classList.remove('hidden');
        } else {
          nudgeText.textContent = state.caller + ' 正在操作 · 点击顶栏「接管」可暂停';
          nudgeAction.classList.add('hidden');
        }
        const left = Math.min(Math.max(event.clientX, 140), Math.max(140, window.innerWidth - 140));
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
