/**
 * 验收 fixture：sandbox 插件的**异步**代码不受 `node:vm` 的 timeout 管，
 * 所以核心在调用外面套了一层上限（`PLUGIN_TIMEOUT`）。
 */
module.exports = {
  async forever() {
    // 永远不 settle 的 Promise：vm 的 timeout 对 await 链无效
    await new Promise(() => {});
    return '永远到不了';
  },

  async quick() {
    return { ok: true };
  },
};
