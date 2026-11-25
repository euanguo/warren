/**
 * Example Cookies 插件：Cookie 受控通道的样例。
 *
 * 这条通道**只搬运不返回**（设计见 docs/PLUGIN-CAPABILITY-DESIGN.md §9）：
 * - `host.cookie.names()` 只回名字 / 域 / 路径 / 过期 / 标志，**没有值**；
 * - `host.cookie.copy()` 的值在主进程内部从 from 读出来直接写进 to，本插件看不到；
 * - `host.cookie.import()` 的值是**调用方给的**（不是我们读出来的），所以不算泄漏；
 * - `host.cookie.clear()` 只回删了几条。
 *
 * 没有 `cookie.read` / `cookie.write` 这种东西——它们在权限表的 denied 层，声明了也不给。
 */
module.exports = {
  async activate(ctx) {
    await ctx.host.log.info('example-cookies activated');
  },

  /** 列当前环境的 cookie 元数据。返回值里搜不到任何 value。 */
  async report(ctx) {
    const cookies = await ctx.host.cookie.names({});
    await ctx.host.log.info(`cookie 元数据 ${cookies.length} 条（只有名字与域）`);
    return {
      count: cookies.length,
      cookies,
    };
  },

  /** 从别的环境搬一份过来：`--input='{"from":"ck1","name":"warren_session"}'`。 */
  async copyFrom(ctx) {
    const from = ctx.input?.from;
    if (!from) {
      throw Object.assign(new Error('copyFrom 需要 --input=\'{"from":"<env>"}\''), {
        code: 'BAD_REQUEST',
      });
    }
    const result = await ctx.host.cookie.copy({ from, name: ctx.input?.name });
    await ctx.host.log.info(`从 ${from} 搬了 ${result.copied} 条 cookie`);
    return result;
  },

  /** 清 cookie。不传 `--domain` 就全清。 */
  async clear(ctx) {
    const result = await ctx.host.cookie.clear({ domain: ctx.input?.domain });
    await ctx.host.log.info(`清了 ${result.removed} 条 cookie`);
    return result;
  },
};
