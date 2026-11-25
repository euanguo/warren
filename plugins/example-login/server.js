/**
 * Example Login 插件（v2）。
 *
 * 运行在 Core 提供的受限上下文里：只有 module/exports、host、console、log。
 * 没有 require、没有 process、没有 fs、没有网络库。
 * 密码永远不经过这里——host.vault.fill 只把值填进页面字段。
 */

/** 从插件设置里取登录页地址；设置由用户在「设置 → 插件」里改 */
async function baseUrl(host) {
  const settings = await host.settings.get();
  return settings.baseUrl || 'http://127.0.0.1:8899/login.html';
}

/** 从 Vault 里挑一个 example provider 的凭据；插件拿不到它的内容，只拿到 ref */
async function pickCredential(host) {
  const refs = await host.vault.listRefs('example');
  if (!refs.length) {
    throw Object.assign(new Error('Vault 里没有 example provider 的凭据'), {
      code: 'CREDENTIAL_NOT_FOUND',
    });
  }
  return refs[0].ref;
}

module.exports = {
  /** 启用时跑一次：把这次激活记进插件日志 */
  async activate(ctx) {
    await ctx.host.log.info('example-login activated');
  },

  async login(ctx) {
    const { host } = ctx;
    const ref = await pickCredential(host);
    const url = await baseUrl(host);

    await host.browser.navigate(url);
    await host.events.emit('auth.navigate', `已打开 ${url}`);

    // 只传 ref 和字段名，密码不出 Vault
    await host.vault.fill(ref, { kind: 'label', text: '邮箱' }, 'username');
    await host.vault.fill(ref, { kind: 'label', text: '密码' }, 'password');
    await host.events.emit('auth.filled', '凭据已填入，插件未接触明文');

    await host.browser.click({ kind: 'role', role: 'button', name: '登录' });

    const snap = await host.browser.snapshot();
    const ok = snap.nodes.some((node) => node.name.includes('已登录'));
    const failed = snap.nodes.some((node) => node.name.includes('不正确'));

    await host.storage.kv.set('lastLoginAt', new Date().toISOString());
    await host.events.emit('auth.login', ok ? '登录成功' : '登录失败');
    return { ok, failed, url: snap.url, title: snap.title, nodes: snap.nodes.length };
  },

  async status(ctx) {
    const snap = await ctx.host.browser.snapshot();
    const ok = snap.nodes.some((node) => node.name.includes('已登录'));
    return {
      loggedIn: ok,
      url: snap.url,
      title: snap.title,
      lastLoginAt: await ctx.host.storage.kv.get('lastLoginAt'),
    };
  },

  async logout(ctx) {
    // fixture 没有真正的登出接口，这里只清掉插件自己记住的状态
    await ctx.host.storage.kv.set('lastLogoutAt', new Date().toISOString());
    return { ok: true };
  },
};
