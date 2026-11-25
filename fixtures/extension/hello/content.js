// 内容脚本跑在隔离世界，但 DOM 是共享的 —— 所以打一个属性，页面侧和 agent 都读得到。
document.documentElement.setAttribute('data-warren-ext', 'hello');
