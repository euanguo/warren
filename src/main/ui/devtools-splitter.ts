import type { DockedDevToolsMode } from '../../shared/devtools-layout.ts';

export interface DevToolsSplitterState {
  dock: DockedDevToolsMode;
  dragging: boolean;
  lineOffset: number;
  theme: 'dark' | 'light';
}

export function buildDevToolsSplitterHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  :root {
    --splitter-divider: rgba(17, 22, 33, 0.085);
    --splitter-hover: rgba(17, 22, 33, 0.24);
    --splitter-focus: color-mix(in oklab, #3b5bdb 82%, transparent);
  }
  body[data-theme="dark"] {
    --splitter-divider: rgba(244, 246, 250, 0.08);
    --splitter-hover: rgba(244, 246, 250, 0.24);
    --splitter-focus: color-mix(in oklab, #5b8cff 82%, transparent);
  }
  html, body {
    margin: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden;
    -webkit-user-select: none; user-select: none;
  }
  #hit {
    position: fixed; inset: 0; outline: none;
    background: transparent;
  }
  body[data-dock="right"] #hit { cursor: col-resize; }
  body[data-dock="bottom"] #hit { cursor: row-resize; }
  #line {
    position: fixed; pointer-events: none;
    background-color: var(--splitter-divider);
    transition: background-color 0.12s ease, width 0.12s ease, height 0.12s ease;
  }
  body[data-dock="right"] #line {
    top: 0; bottom: 0; left: 50%; width: 1px;
    transform: translateX(-50%);
  }
  body[data-dock="bottom"] #line {
    left: 0; right: 0; top: 50%; height: 1px;
    transform: translateY(-50%);
  }
  body[data-hover="true"] #line {
    background-color: var(--splitter-hover);
  }
  body[data-dock="right"][data-hover="true"] #line { width: 2px; }
  body[data-dock="bottom"][data-hover="true"] #line { height: 2px; }
  body[data-dragging="true"] #line {
    background-color: var(--splitter-focus);
    transition: none;
  }
  body[data-dock="right"][data-dragging="true"] #line { width: 2px; }
  body[data-dock="bottom"][data-dragging="true"] #line { height: 2px; }
</style></head>
<body data-dock="right" data-theme="dark" data-hover="false" data-dragging="false">
  <div id="hit" tabindex="-1"><div id="line"></div></div>
  <script>
    (() => {
      const hit = document.getElementById('hit');
      const line = document.getElementById('line');
      let dragging = false;
      let pointerId = -1;
      let raf = 0;
      let pendingMove = null;
      let lastX = 0;
      let lastY = 0;
      let currentDock = 'right';

      function applySync(state) {
        if (!state) return;
        currentDock = state.dock === 'bottom' ? 'bottom' : 'right';
        document.body.dataset.dock = currentDock;
        document.body.dataset.theme = state.theme === 'light' ? 'light' : 'dark';
        const activeDrag = Boolean(state.dragging && dragging);
        document.body.dataset.dragging = activeDrag ? 'true' : 'false';
        if (activeDrag && typeof state.lineOffset === 'number' && Number.isFinite(state.lineOffset)) {
          if (currentDock === 'right') {
            line.style.left = state.lineOffset + 'px';
            line.style.top = '0';
          } else {
            line.style.top = state.lineOffset + 'px';
            line.style.left = '0';
          }
        } else {
          line.style.left = '';
          line.style.top = '';
        }
      }

      function flushMove() {
        raf = 0;
        if (!dragging || !pendingMove) return;
        const next = pendingMove;
        pendingMove = null;
        window.splitterBridge?.send({ type: 'move', screenX: next.x, screenY: next.y });
      }

      function finish(screenX, screenY, cancel) {
        if (!dragging) return;
        dragging = false;
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        pendingMove = null;
        document.body.dataset.dragging = 'false';
        line.style.left = '';
        line.style.top = '';
        if (cancel) document.body.dataset.hover = 'false';
        if (pointerId >= 0) {
          try { hit.releasePointerCapture(pointerId); } catch {}
          pointerId = -1;
        }
        window.splitterBridge?.send({ type: 'end', screenX, screenY, cancel });
      }

      hit.addEventListener('pointerenter', () => {
        document.body.dataset.hover = 'true';
      });
      hit.addEventListener('pointerleave', () => {
        if (!dragging) document.body.dataset.hover = 'false';
      });
      hit.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        hit.focus({ preventScroll: true });
        dragging = true;
        pointerId = event.pointerId;
        lastX = event.screenX;
        lastY = event.screenY;
        document.body.dataset.dragging = 'true';
        try { hit.setPointerCapture(event.pointerId); } catch {}
        window.splitterBridge?.send({ type: 'start', screenX: event.screenX, screenY: event.screenY });
      });
      hit.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        if ((event.buttons & 1) === 0) {
          finish(event.screenX, event.screenY, false);
          return;
        }
        lastX = event.screenX;
        lastY = event.screenY;
        pendingMove = { x: event.screenX, y: event.screenY };
        if (!raf) raf = requestAnimationFrame(flushMove);
      });
      hit.addEventListener('pointerup', (event) => {
        finish(event.screenX, event.screenY, false);
      });
      hit.addEventListener('pointercancel', () => {
        finish(lastX, lastY, false);
      });
      window.addEventListener('blur', () => {
        document.body.dataset.hover = 'false';
        finish(lastX, lastY, false);
      });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && dragging) {
          event.preventDefault();
          finish(lastX, lastY, true);
        }
      });
      hit.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (dragging) finish(event.screenX, event.screenY, true);
        window.splitterBridge?.send({ type: 'reset' });
      });

      window.splitterBridge?.onSync(applySync);
    })();
  </script>
</body></html>`;
}
