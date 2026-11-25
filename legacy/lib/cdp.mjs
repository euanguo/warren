// 零依赖 CDP 客户端。Node 18+ 与 Electron 主进程都自带全局 WebSocket。
// 检测面守则：全程不调用 Runtime.* / Console.* / Emulation.*
export class CDP {
  #ws; #seq = 0; #pending = new Map(); #sessions = new Map();

  static async connect(wsUrl) {
    const c = new CDP();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      c.#ws.addEventListener("open", res, { once: true });
      c.#ws.addEventListener("error", () => rej(new Error(`CDP 连接失败 ${wsUrl}`)), { once: true });
    });
    c.#ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id == null) return;
      const p = c.#pending.get(m.id);
      c.#pending.delete(m.id);
      if (!p) return;
      m.error ? p.rej(new Error(`${m.error.message} (${m.error.code})`)) : p.res(m.result);
    });
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#seq;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej });
      this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** 找页面 target，attach 一次并缓存 sessionId（重复 attach 会泄漏 session） */
  async pageSession() {
    const { targetInfos } = await this.send("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
    if (!pages.length) return null;
    const target = pages.find((t) => this.#sessions.has(t.targetId)) ?? pages[0];
    if (!this.#sessions.has(target.targetId)) {
      const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      this.#sessions.set(target.targetId, sessionId);
    }
    return { target, sessionId: this.#sessions.get(target.targetId) };
  }

  /** 当前在干什么：URL + 标题。只用 browser 级 getTargets，不需要任何 enable */
  async status() {
    const s = await this.pageSession();
    if (!s) return { url: "", title: "" };
    return { url: s.target.url, title: s.target.title };
  }

  /** 缩略图。Page.captureScreenshot 不需要 Page.enable */
  async thumbnail(scale = 0.35, quality = 55) {
    const s = await this.pageSession();
    if (!s) return null;
    let clip;
    try {
      const m = await this.send("Page.getLayoutMetrics", {}, s.sessionId);
      const vp = m.cssLayoutViewport ?? m.layoutViewport;
      if (vp?.clientWidth) clip = { x: 0, y: 0, width: vp.clientWidth, height: vp.clientHeight, scale };
    } catch { /* 拿不到就整屏截 */ }
    const { data } = await this.send(
      "Page.captureScreenshot",
      { format: "jpeg", quality, ...(clip ? { clip } : {}) },
      s.sessionId,
    );
    return Buffer.from(data, "base64");
  }

  close() { try { this.#ws.close(); } catch {} }
}
