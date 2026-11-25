import test from 'node:test';
import assert from 'node:assert/strict';
import {
  controlModeFor,
  pluginAutoApproves,
  toAppSettings,
  DEFAULT_APP_SETTINGS,
} from '../src/main/domain/approval.ts';

/*
 * 审批策略的判定表。这是「AI 能不能自己动手」的唯一开关，所以组合要逐个钉住。
 * 见 docs/APPROVAL-EMBED-MEMORY-PLAN.md §3。
 */

test('默认策略：谁建的环境都要人点头', () => {
  assert.equal(controlModeFor({ policy: 'ask', createdBy: 'agent' }), 'ask');
  assert.equal(controlModeFor({ policy: 'ask', createdBy: 'human' }), 'ask');
});

test('agent-created：只对 AI 建的环境放行', () => {
  assert.equal(controlModeFor({ policy: 'agent-created', createdBy: 'agent' }), 'auto');
  assert.equal(controlModeFor({ policy: 'agent-created', createdBy: 'human' }), 'ask');
});

test('auto：不管谁建的都放行', () => {
  assert.equal(controlModeFor({ policy: 'auto', createdBy: 'agent' }), 'auto');
  assert.equal(controlModeFor({ policy: 'auto', createdBy: 'human' }), 'auto');
});

test('环境级覆盖优先于全局（两个方向都试）', () => {
  // 全局最松，环境上写死要审批 → 仍然要审批
  assert.equal(controlModeFor({ policy: 'auto', envApproval: 'ask', createdBy: 'agent' }), 'ask');
  // 全局最严，环境上写死放行 → 放行
  assert.equal(controlModeFor({ policy: 'ask', envApproval: 'auto', createdBy: 'human' }), 'auto');
  // inherit 等于没写
  assert.equal(controlModeFor({ policy: 'auto', envApproval: 'inherit', createdBy: 'human' }), 'auto');
  assert.equal(controlModeFor({ policy: 'ask', envApproval: 'inherit', createdBy: 'agent' }), 'ask');
});

test('插件能力确认：只有 auto 才自动批准', () => {
  assert.equal(pluginAutoApproves({ ...DEFAULT_APP_SETTINGS, pluginPolicy: 'auto' }), true);
  assert.equal(pluginAutoApproves({ ...DEFAULT_APP_SETTINGS, pluginPolicy: 'ask' }), false);
});

test('库里读出来的脏值退回默认，不抛', () => {
  assert.deepEqual(toAppSettings({}), DEFAULT_APP_SETTINGS);
  assert.deepEqual(toAppSettings({ controlPolicy: 'yes', pluginPolicy: 'nope' }), DEFAULT_APP_SETTINGS);
  assert.deepEqual(toAppSettings({ controlPolicy: 'auto', pluginPolicy: 'auto' }), {
    controlPolicy: 'auto',
    pluginPolicy: 'auto',
  });
});
