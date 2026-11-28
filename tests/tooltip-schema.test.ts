import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTooltipRequest } from '../src/shared/tooltip-schema.ts';

function rejects(input: unknown, message: RegExp): void {
  assert.throws(
    () => normalizeTooltipRequest(input),
    (error: unknown) => {
      const err = error as Error & { code?: string };
      assert.equal(err.code, 'OVERLAY_TOOLTIP_INVALID');
      assert.match(err.message, message);
      return true;
    },
  );
}

const VALID = {
  anchor: { x: 69, y: 89, width: 32, height: 32 },
  side: 'right',
  label: 'React',
  description: '运行中 · 直连',
  shortcut: '⌘K',
  extra: 'drop me',
};

test('normalizeTooltipRequest：合法请求只保留已知字段', () => {
  assert.deepEqual(normalizeTooltipRequest(VALID), {
    anchor: { x: 69, y: 89, width: 32, height: 32 },
    side: 'right',
    label: 'React',
    description: '运行中 · 直连',
    shortcut: '⌘K',
  });
});

test('normalizeTooltipRequest：缺省 side 兜底为 bottom，空副说明被丢弃', () => {
  const normalized = normalizeTooltipRequest({ anchor: VALID.anchor, label: '  设置  ', description: '   ' });
  assert.equal(normalized.side, 'bottom');
  assert.equal(normalized.label, '设置');
  assert.equal(normalized.description, undefined);
  assert.equal(normalized.shortcut, undefined);
});

test('normalizeTooltipRequest：超长文案被裁到上限', () => {
  const normalized = normalizeTooltipRequest({
    anchor: VALID.anchor,
    label: 'x'.repeat(400),
    description: 'y'.repeat(400),
    shortcut: 'z'.repeat(40),
  });
  assert.equal(normalized.label.length, 120);
  assert.equal(normalized.description?.length, 240);
  assert.equal(normalized.shortcut?.length, 16);
});

test('normalizeTooltipRequest：拒绝非法输入', () => {
  rejects(null, /请求必须是对象/);
  rejects({ anchor: VALID.anchor }, /label 不能为空/);
  rejects({ anchor: VALID.anchor, label: 12 }, /label 必须是字符串/);
  rejects({ label: 'x' }, /anchor 必须是对象/);
  rejects({ anchor: { ...VALID.anchor, x: Number.NaN }, label: 'x' }, /anchor\.x/);
  rejects({ anchor: VALID.anchor, label: 'x', side: 'diagonal' }, /side 不合法/);
});

test('normalizeTooltipRequest：负宽高夹到 0', () => {
  const normalized = normalizeTooltipRequest({ anchor: { x: 1, y: 2, width: -5, height: -1 }, label: 'x' });
  assert.deepEqual(normalized.anchor, { x: 1, y: 2, width: 0, height: 0 });
});
