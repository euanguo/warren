import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPACT_STAGE_WIDTH_THRESHOLD,
  MIN_PAGE_WIDTH_FOR_DUAL_RIGHT,
  shouldExcludeRightPanels,
} from '../src/renderer/state/workbench-layout.ts';
import {
  getNavigationSnapshot,
  openEnvironments,
  openPluginPage,
  openSettings,
  setInspectorOpen,
  setInspectorTab,
  toggleSettings,
} from '../src/renderer/state/navigation-store.ts';

test('shouldExcludeRightPanels：bottom 与 detach 永不与工作台互斥', () => {
  assert.equal(
    shouldExcludeRightPanels({
      stageContainerWidth: 900,
      inspectorWidth: 360,
      devToolsDock: 'bottom',
      devToolsSize: 420,
    }),
    false,
  );
  assert.equal(
    shouldExcludeRightPanels({
      stageContainerWidth: 900,
      inspectorWidth: 360,
      devToolsDock: 'detach',
      devToolsSize: 420,
    }),
    false,
  );
});

test('shouldExcludeRightPanels：右侧停靠在窄屏或网页剩宽不足 520px 时互斥，超宽屏可并存', () => {
  assert.equal(
    shouldExcludeRightPanels({
      stageContainerWidth: COMPACT_STAGE_WIDTH_THRESHOLD - 1,
      inspectorWidth: 300,
      devToolsDock: 'right',
      devToolsSize: 300,
    }),
    true,
  );
  assert.equal(
    shouldExcludeRightPanels({
      stageContainerWidth: 1200,
      inspectorWidth: 360,
      devToolsDock: 'right',
      devToolsSize: 420,
    }),
    true,
  );
  assert.equal(
    shouldExcludeRightPanels({
      stageContainerWidth: 360 + 420 + MIN_PAGE_WIDTH_FOR_DUAL_RIGHT,
      inspectorWidth: 360,
      devToolsDock: 'right',
      devToolsSize: 420,
    }),
    false,
  );
});

test('navigation-store：全局设置、插件页切换及返回环境状态流转清晰', () => {
  openEnvironments();
  assert.equal(getNavigationSnapshot().route, 'environments');

  openSettings('plugins');
  assert.equal(getNavigationSnapshot().route, 'settings');
  assert.equal(getNavigationSnapshot().settingsSection, 'plugins');

  // 再次 toggle 同一分节回到环境页
  toggleSettings('plugins');
  assert.equal(getNavigationSnapshot().route, 'environments');

  openPluginPage('com.warren.whistle', 'proxy');
  assert.equal(getNavigationSnapshot().route, 'pluginPage');
  assert.deepEqual(getNavigationSnapshot().requestedPage, {
    pluginId: 'com.warren.whistle',
    surfaceId: 'proxy',
  });

  openEnvironments();
  assert.equal(getNavigationSnapshot().route, 'environments');
  assert.equal(getNavigationSnapshot().requestedPage, undefined);

  setInspectorOpen(true);
  setInspectorTab('rules');
  assert.equal(getNavigationSnapshot().inspectorOpen, true);
  assert.equal(getNavigationSnapshot().inspectorTab, 'rules');
  setInspectorOpen(false);
});
