/** 渲染期直接抛异常：验证错误边界只吃掉这一块。 */
export default function register(app) {
  const { h } = app;
  function Boom() {
    throw new Error('插件页面故意炸了');
  }
  app.surfaces.railPage({ id: 'boom', title: '坏插件', icon: 'Zap', path: 'boom', component: Boom });
}
