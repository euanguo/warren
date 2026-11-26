import type { NativeMenuItem } from '../shared/types.ts';

export interface PageContextSnapshot {
  x: number;
  y: number;
  pageURL: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canNavigate: boolean;
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/**
 * 纯函数构造网页右键菜单模板（无 Electron 依赖，可直接单测）。
 */
export function buildPageContextMenu(params: PageContextSnapshot): NativeMenuItem[] {
  const items: NativeMenuItem[] = [];
  const navSuffix = params.canNavigate ? '' : '（需要先接管）';

  if (params.linkURL) {
    items.push(
      { id: 'link:openTab', label: '在新标签页中打开链接', enabled: params.canNavigate },
      { id: 'link:copy', label: '复制链接地址' },
      { type: 'separator' },
    );
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push(
      { id: 'image:openTab', label: '在新标签页中打开图片', enabled: params.canNavigate },
      { id: 'image:copy', label: '复制图片' },
      { id: 'image:copyUrl', label: '复制图片地址' },
      { id: 'image:saveAs', label: '图片另存为…' },
      { type: 'separator' },
    );
  }

  if (params.isEditable) {
    items.push(
      { id: 'edit:undo', label: '撤销', enabled: params.editFlags.canUndo },
      { id: 'edit:redo', label: '重做', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { id: 'edit:cut', label: '剪切', enabled: params.editFlags.canCut },
      { id: 'edit:copy', label: '复制', enabled: params.editFlags.canCopy },
      { id: 'edit:paste', label: '粘贴', enabled: params.editFlags.canPaste },
      { id: 'edit:selectAll', label: '全选', enabled: params.editFlags.canSelectAll },
      { type: 'separator' },
    );
  } else if (params.selectionText.trim()) {
    items.push({ id: 'edit:copy', label: '复制' }, { id: 'edit:selectAll', label: '全选' }, { type: 'separator' });
  }

  items.push(
    { id: 'nav:back', label: `返回${navSuffix}`, enabled: params.canNavigate && params.canGoBack },
    { id: 'nav:forward', label: `前进${navSuffix}`, enabled: params.canNavigate && params.canGoForward },
    { id: 'nav:reload', label: `重新加载${navSuffix}`, enabled: params.canNavigate },
    { id: 'nav:hardReload', label: `忽略缓存硬刷新${navSuffix}`, enabled: params.canNavigate },
    { type: 'separator' },
    { id: 'page:saveAs', label: '将页面另存为…' },
    { id: 'page:print', label: '打印…' },
  );

  if (params.pageURL && !params.pageURL.startsWith('view-source:')) {
    items.push({ id: 'page:viewSource', label: '查看网页源代码', enabled: params.canNavigate });
  }

  items.push({ type: 'separator' }, { id: 'devtools:inspect', label: `检查${navSuffix}`, enabled: params.canNavigate });

  return items;
}
