export interface RpcMethodMeta {
  name: string;
  kind: 'read' | 'change';
  summary: string;
  params: string[];
}

/**
 * RPC 协议能力声明目录：由 `rpc.methods` 与 `warren methods` 实时返回，
 * 消除「靠文档猜方法名和参数」的漂移问题。
 */
export const RPC_METHODS: readonly RpcMethodMeta[] = [
  { name: 'ping', kind: 'read', summary: '健康探针', params: [] },
  { name: 'rpc.methods', kind: 'read', summary: '列出所有可用 RPC 方法与参数', params: ['name?'] },
  { name: 'settings.get', kind: 'read', summary: '读取只读应用设置与审批策略', params: [] },
  { name: 'env.list', kind: 'read', summary: '列出全部浏览器环境', params: [] },
  { name: 'env.get', kind: 'read', summary: '读取单个环境详情', params: ['id'] },
  {
    name: 'env.create',
    kind: 'change',
    summary: '创建新环境',
    params: ['id', 'name?', 'proxy?', 'startUrl?', 'headed?'],
  },
  { name: 'env.start', kind: 'change', summary: '启动环境', params: ['id'] },
  { name: 'env.stop', kind: 'change', summary: '停止环境', params: ['id'] },
  { name: 'env.remove', kind: 'change', summary: '删除环境及其存储目录', params: ['id'] },
  {
    name: 'env.update',
    kind: 'change',
    summary: '更新环境配置（name/proxy/startUrl）',
    params: ['id', 'name?', 'proxy?', 'startUrl?'],
  },
  { name: 'env.hibernate', kind: 'change', summary: '休眠环境释放渲染进程内存', params: ['id'] },
  { name: 'env.wake', kind: 'change', summary: '从休眠唤醒环境', params: ['id'] },
  { name: 'env.acquire', kind: 'change', summary: '申请 Agent Space 控制权租约', params: ['id', 'label?', 'space?'] },
  { name: 'env.renew', kind: 'change', summary: '续租当前控制权 leaseId', params: ['id', 'leaseId'] },
  { name: 'env.release', kind: 'change', summary: '归还控制权', params: ['id', 'leaseId'] },
  { name: 'env.takeover', kind: 'change', summary: '人工强接管 Agent Space', params: ['id', 'space?'] },
  { name: 'env.egress', kind: 'read', summary: '查看环境出口与实时页面摘要', params: ['id'] },
  { name: 'env.doctor', kind: 'read', summary: '运行环境代理与端口预检', params: ['id', 'localPorts?'] },
  { name: 'events.list', kind: 'read', summary: '读取环境或全局事件流', params: ['environmentId?'] },
  {
    name: 'events.since',
    kind: 'read',
    summary: '按游标/时间增量读取事件',
    params: ['environmentId?', 'afterId?', 'since?', 'limit?'],
  },
  { name: 'tab.list', kind: 'read', summary: '列出环境当前或指定 Space 标签', params: ['id', 'space?'] },
  { name: 'tab.new', kind: 'change', summary: '新建标签页', params: ['id', 'url?', 'activate?', 'leaseId?', 'space?'] },
  { name: 'tab.select', kind: 'change', summary: '切换激活标签', params: ['id', 'ref', 'leaseId?', 'space?'] },
  { name: 'tab.close', kind: 'change', summary: '关闭指定标签', params: ['id', 'ref', 'leaseId?', 'space?'] },
  { name: 'tab.reopen', kind: 'change', summary: '恢复最近关闭的标签', params: ['id', 'leaseId?', 'space?'] },
  {
    name: 'browser.navigate',
    kind: 'change',
    summary: '导航到指定 URL',
    params: ['id', 'url', 'leaseId', 'waitUntil?'],
  },
  { name: 'browser.reload', kind: 'change', summary: '刷新当前页', params: ['id', 'leaseId', 'waitUntil?'] },
  { name: 'browser.goBack', kind: 'change', summary: '后退', params: ['id', 'leaseId'] },
  { name: 'browser.goForward', kind: 'change', summary: '前进', params: ['id', 'leaseId'] },
  { name: 'browser.click', kind: 'change', summary: '等待可用性并点击元素', params: ['id', 'target', 'leaseId'] },
  { name: 'browser.dblclick', kind: 'change', summary: '双击元素', params: ['id', 'target', 'leaseId'] },
  { name: 'browser.hover', kind: 'change', summary: '悬停元素', params: ['id', 'target', 'leaseId'] },
  { name: 'browser.fill', kind: 'change', summary: '清空并填写输入框', params: ['id', 'target', 'value', 'leaseId'] },
  {
    name: 'browser.selectOption',
    kind: 'change',
    summary: '选择下拉选项',
    params: ['id', 'target', 'value', 'leaseId'],
  },
  { name: 'browser.press', kind: 'change', summary: '发送按键/组合键', params: ['id', 'target?', 'key', 'leaseId'] },
  {
    name: 'browser.find',
    kind: 'change',
    summary: '语义定位器一步定位并执行动作或读取状态',
    params: ['id', 'by', 'spec', 'action', 'value?', 'name?', 'attr?', 'leaseId?'],
  },
  {
    name: 'browser.batch',
    kind: 'change',
    summary: '多步原子批处理并返回 Delta Receipt',
    params: ['id', 'steps|script', 'bail?', 'leaseId?'],
  },
  {
    name: 'browser.snapshot',
    kind: 'read',
    summary: '读取可访问性树、分配 @N 并按需输出紧凑视图',
    params: ['id', 'scope?', 'interactiveOnly?', 'compact?', 'maxDepth?', 'selector?'],
  },
  {
    name: 'browser.read',
    kind: 'read',
    summary: '抽取页面干净正文、结构化 JSON 与链接',
    params: ['id', 'selector?', 'data?', 'links?', 'scroll?'],
  },
  {
    name: 'browser.get',
    kind: 'read',
    summary: '读取页面或元素的 url/title/text/html/value/attr/box',
    params: ['id', 'prop', 'target?', 'attr?'],
  },
  {
    name: 'browser.is',
    kind: 'read',
    summary: '检查元素 visible/enabled/checked 状态',
    params: ['id', 'state', 'target'],
  },
  {
    name: 'browser.diff',
    kind: 'read',
    summary: '比对前后两次快照或两张截图差异',
    params: ['id', 'kind?', 'a?', 'b?', 'interactiveOnly?'],
  },
  {
    name: 'browser.screenshot',
    kind: 'read',
    summary: '截图落盘并返回元数据',
    params: ['id', 'path?', 'fullPage?', 'format?', 'encoding?'],
  },
  { name: 'browser.console', kind: 'read', summary: '查看页面 Console 摘要', params: ['id'] },
  { name: 'browser.network', kind: 'read', summary: '查看页面网络请求摘要', params: ['id'] },
  { name: 'browser.info', kind: 'read', summary: '查看 URL/标题/加载态/弹窗', params: ['id'] },
  { name: 'browser.events', kind: 'read', summary: '读取并消费弹窗/弹出标签/下载队列', params: ['id'] },
  { name: 'browser.highlight', kind: 'read', summary: '在页面绘制高亮边框', params: ['id', 'target?'] },
  { name: 'notes.list', kind: 'read', summary: '列出所有站点记忆笔记', params: [] },
  { name: 'notes.get', kind: 'read', summary: '读取指定站点记忆', params: ['site'] },
  {
    name: 'notes.set',
    kind: 'change',
    summary: '写入或覆盖站点记忆（严禁凭据明文）',
    params: ['site', 'content', 'updatedBy?'],
  },
  { name: 'notes.append', kind: 'change', summary: '追加一行站点记忆', params: ['site', 'text', 'updatedBy?'] },
  { name: 'notes.rm', kind: 'change', summary: '删除站点记忆', params: ['site'] },
  { name: 'net.rules', kind: 'read', summary: '列出环境网络拦截规则', params: ['id'] },
  { name: 'net.rule.add', kind: 'change', summary: '添加网络拦截规则', params: ['id', 'rule', 'leaseId'] },
  { name: 'net.hits', kind: 'read', summary: '读取拦截命中记录', params: ['id', 'limit?'] },
  { name: 'vault.list', kind: 'read', summary: '列出打码凭据摘要', params: [] },
  {
    name: 'vault.fill',
    kind: 'change',
    summary: '直接向页面填充 Vault 凭据（不回传明文）',
    params: ['id', 'ref', 'field', 'target', 'leaseId'],
  },
  { name: 'plugin.list', kind: 'read', summary: '列出已安装插件', params: [] },
  {
    name: 'plugin.run',
    kind: 'change',
    summary: '执行插件注册命令',
    params: ['id', 'command', 'env?', 'input?', 'leaseId?'],
  },
  { name: 'plugin.rpc', kind: 'change', summary: '调用插件 RPC', params: ['id', 'method', 'input?', 'leaseId?'] },
];

export function findRpcMethods(query?: string): RpcMethodMeta[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...RPC_METHODS];
  return RPC_METHODS.filter((m) => m.name.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q));
}
