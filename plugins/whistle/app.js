/**
 * Whistle 代理插件前端（whistle@2.10.15 多面协同专业工作台）。
 *
 * 无构建步骤：纯浏览器 ESM，由主进程经 `warren-plugin://com.warren.whistle/app.js` 供给；
 * React 与组件库全部由宿主注入（`app.React` / `app.h` / `app.ui`）。
 */
import { createInspectorViews } from './ui/inspector.js';
import { createPopoverViews } from './ui/popover.js';
import { createProxyPageViews } from './ui/proxy-page.js';
import { createRulesValuesPresetsTabs } from './ui/rules-values-presets.js';
import { createWhistleUiContext } from './ui/shared.js';
import { createTrafficDoctorTabs } from './ui/traffic-doctor.js';

export default function register(app) {
  const ctx = createWhistleUiContext(app);
  const { ProxyStatusBadge, QuickProxyPopover } = createPopoverViews(ctx);
  const { WhistleInspectorTab } = createInspectorViews(ctx);
  const { RulesTab, ValuesTab, PresetsTab } = createRulesValuesPresetsTabs(ctx);
  const { TrafficTab, DoctorTab } = createTrafficDoctorTabs(ctx);
  const { ProxyPage, AboutSection } = createProxyPageViews(ctx, {
    RulesTab,
    ValuesTab,
    PresetsTab,
    TrafficTab,
    DoctorTab,
  });

  app.surfaces.railPage({ id: 'proxy', title: '代理', icon: 'Globe', path: 'proxy', component: ProxyPage });
  app.surfaces.inspectorTab({ id: 'env-proxy', title: '代理', component: WhistleInspectorTab });
  app.surfaces.settingsSection({ id: 'about', title: 'Whistle 使用说明', component: AboutSection });
  app.surfaces.popover({
    id: 'quick-proxy',
    title: 'Whistle 代理快捷控制',
    icon: 'Globe',
    width: 380,
    height: 492,
    component: QuickProxyPopover,
  });
  app.surfaces.statusBadge({
    id: 'proxy-badge',
    title: '代理运行状态',
    icon: 'Globe',
    component: ProxyStatusBadge,
  });
}
