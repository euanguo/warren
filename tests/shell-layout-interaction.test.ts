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
import { ENV_IDENTITY_HUES, getEnvIdentity } from '../src/renderer/lib/env-identity.ts';
import { getPluginBrand } from '../src/renderer/lib/plugin-brand.ts';

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

test('env-identity：隔离环境色标映射确定且落在 8 组色相内', () => {
  const a1 = getEnvIdentity('env-cap', 'cap');
  const a2 = getEnvIdentity('env-cap', 'cap');
  assert.deepEqual(a1, a2);
  assert.equal(a1.initial, 'C');
  assert.ok((ENV_IDENTITY_HUES as readonly number[]).includes(a1.hue));
  assert.equal(getEnvIdentity('env-cn', '测试环境').initial, '测');
});

test('plugin-brand：内置插件具备独立品牌图标与色相，第三方插件有稳定回退', () => {
  const whistle = getPluginBrand('com.warren.whistle');
  const accounts = getPluginBrand('com.warren.accounts');
  const notes = getPluginBrand('com.example.notes');
  assert.equal(whistle.icon, 'Globe');
  assert.equal(accounts.icon, 'Key');
  assert.equal(notes.icon, 'List');
  assert.notEqual(whistle.hue, accounts.hue);
  assert.notEqual(accounts.hue, notes.hue);
  const custom = getPluginBrand('com.thirdparty.custom');
  assert.equal(custom.icon, 'Plug');
  assert.equal(custom.hue, getPluginBrand('com.thirdparty.custom').hue);
});
