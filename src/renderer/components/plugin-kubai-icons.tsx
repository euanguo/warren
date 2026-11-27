/**
 * 插件专属 Kubai Icons 按需数据映射层（方案 1：小入口 Duotone 双色实心 + 大卡片 Layered 分层微立体）。
 *
 * 严格按单图标子路径引入纯数据模块（`kubai-icons/duotone/icons/*` 与 `kubai-icons/icons/*`），
 * 再由单一静态组件 `<KubaiIcon icon={data} />` 渲染：
 * 1. 避免全量 barrel 打包与 38 份多余 forwardRef 包装；
 * 2. 100% 满足 React Compiler 静态组件规则（无渲染期动态组件引用）；
 * 3. 全部支持 `trigger="parent"` 随宿主按钮/卡片悬停播放微动效。
 */
import type { KubaiIconData } from 'kubai-icons';

// 小尺寸入口（14–18px）：16px 网格双色实心 Duotone，小字号下锐利饱满不发糊
import duoActivity from 'kubai-icons/duotone/icons/activity';
import duoBug from 'kubai-icons/duotone/icons/bug';
import duoCode from 'kubai-icons/duotone/icons/code';
import duoCookie from 'kubai-icons/duotone/icons/cookie';
import duoFolder from 'kubai-icons/duotone/icons/folder';
import duoGlobe from 'kubai-icons/duotone/icons/globe';
import duoIdCard from 'kubai-icons/duotone/icons/id-card';
import duoKey from 'kubai-icons/duotone/icons/key';
import duoLockKeyhole from 'kubai-icons/duotone/icons/lock-keyhole';
import duoNotebook from 'kubai-icons/duotone/icons/notebook';
import duoPackage from 'kubai-icons/duotone/icons/package';
import duoPlug from 'kubai-icons/duotone/icons/plug';
import duoRouter from 'kubai-icons/duotone/icons/router';
import duoShield from 'kubai-icons/duotone/icons/shield';
import duoSliders from 'kubai-icons/duotone/icons/sliders';
import duoSparkles from 'kubai-icons/duotone/icons/sparkles';
import duoTerminal from 'kubai-icons/duotone/icons/terminal';
import duoWrench from 'kubai-icons/duotone/icons/wrench';

// 大尺寸徽标（24–36px，插件管理卡 / 插件页顶栏）：Layered 分层微立体 + 柔和渐变 + 外描边
import layeredActivity from 'kubai-icons/icons/activity';
import layeredBlocks from 'kubai-icons/icons/blocks';
import layeredBug from 'kubai-icons/icons/bug';
import layeredCode from 'kubai-icons/icons/code';
import layeredContactBook from 'kubai-icons/icons/contact-book';
import layeredCookie from 'kubai-icons/icons/cookie';
import layeredFolder from 'kubai-icons/icons/folder';
import layeredGlobe from 'kubai-icons/icons/globe';
import layeredKeyRound from 'kubai-icons/icons/key-round';
import layeredLockKeyhole from 'kubai-icons/icons/lock-keyhole';
import layeredNotebookPen from 'kubai-icons/icons/notebook-pen';
import layeredPackage from 'kubai-icons/icons/package';
import layeredRouter from 'kubai-icons/icons/router';
import layeredShieldCheck from 'kubai-icons/icons/shield-check';
import layeredSliders from 'kubai-icons/icons/sliders';
import layeredSparkles from 'kubai-icons/icons/sparkles';
import layeredTerminal from 'kubai-icons/icons/terminal';
import layeredWrench from 'kubai-icons/icons/wrench';
import layeredZap from 'kubai-icons/icons/zap';

export type PluginKubaiStyle = 'duotone' | 'layered';

const DUOTONE_DATA_MAP: Readonly<Record<string, KubaiIconData>> = {
  Activity: duoActivity,
  Bug: duoBug,
  Code: duoCode,
  Cookie: duoCookie,
  ExternalLink: duoPlug,
  Folder: duoFolder,
  Globe: duoGlobe,
  Key: duoKey,
  List: duoNotebook,
  Lock: duoLockKeyhole,
  Package: duoPackage,
  PanelRight: duoSliders,
  Plug: duoPlug,
  Router: duoRouter,
  Shield: duoShield,
  Sliders: duoSliders,
  Sparkles: duoSparkles,
  Terminal: duoTerminal,
  User: duoIdCard,
  Wrench: duoWrench,
  Zap: duoSparkles,
};

const LAYERED_DATA_MAP: Readonly<Record<string, KubaiIconData>> = {
  Activity: layeredActivity,
  Bug: layeredBug,
  Code: layeredCode,
  Cookie: layeredCookie,
  ExternalLink: layeredBlocks,
  Folder: layeredFolder,
  Globe: layeredGlobe,
  Key: layeredKeyRound,
  List: layeredNotebookPen,
  Lock: layeredLockKeyhole,
  Package: layeredPackage,
  PanelRight: layeredSliders,
  Plug: layeredBlocks,
  Router: layeredRouter,
  Shield: layeredShieldCheck,
  Sliders: layeredSliders,
  Sparkles: layeredSparkles,
  Terminal: layeredTerminal,
  User: layeredContactBook,
  Wrench: layeredWrench,
  Zap: layeredZap,
};

/** 将插件语义图标名解析为对应的 Kubai Duotone / Layered 图标数据，未知名称回退为插件通用图标。 */
export function resolvePluginKubaiIconData(name: string, style: PluginKubaiStyle): KubaiIconData {
  if (style === 'layered') {
    return LAYERED_DATA_MAP[name] ?? layeredBlocks;
  }
  return DUOTONE_DATA_MAP[name] ?? duoPlug;
}
