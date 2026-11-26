import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPageContextMenu } from '../src/main/browser-context-menu.ts';

const baseParams = {
  x: 100,
  y: 200,
  pageURL: 'https://example.com/page',
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  canGoBack: true,
  canGoForward: false,
  canNavigate: true,
  editFlags: {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: true,
    canSelectAll: true,
  },
};

test('链接与图片上下文呈现对应菜单项并含检查元素', () => {
  const items = buildPageContextMenu({
    ...baseParams,
    linkURL: 'https://example.com/next',
    mediaType: 'image',
    srcURL: 'https://example.com/a.png',
  });
  const ids = items.map((i) => i.id).filter(Boolean);
  assert.ok(ids.includes('link:openTab'));
  assert.ok(ids.includes('link:copy'));
  assert.ok(ids.includes('image:saveAs'));
  assert.ok(ids.includes('nav:hardReload'));
  assert.ok(ids.includes('devtools:inspect'));
});

test('未持有控制权时禁用写导航与检查元素并标注原因', () => {
  const items = buildPageContextMenu({
    ...baseParams,
    canNavigate: false,
  });
  const reload = items.find((i) => i.id === 'nav:reload');
  const inspect = items.find((i) => i.id === 'devtools:inspect');
  assert.equal(reload?.enabled, false);
  assert.match(reload?.label ?? '', /需要先接管/);
  assert.equal(inspect?.enabled, false);
});

test('可编辑区域展示原生剪贴板与撤销重做项', () => {
  const items = buildPageContextMenu({
    ...baseParams,
    isEditable: true,
  });
  const paste = items.find((i) => i.id === 'edit:paste');
  assert.equal(paste?.enabled, true);
});
