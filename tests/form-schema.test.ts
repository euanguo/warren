import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFormRequest } from '../src/shared/form-schema.ts';

function rejects(input: unknown, message: RegExp): void {
  assert.throws(
    () => normalizeFormRequest(input),
    (error: unknown) => {
      const err = error as Error & { code?: string };
      assert.equal(err.code, 'OVERLAY_FORM_INVALID');
      assert.match(err.message, message);
      return true;
    },
  );
}

const VALID = {
  kind: 'form',
  title: '新建分组',
  submitLabel: '创建',
  fields: [
    { type: 'text', key: 'name', label: '分组名', required: true, maxLength: 40 },
    {
      type: 'select',
      key: 'scope',
      label: '范围',
      initial: 'b',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    { type: 'switch', key: 'notify', label: '通知', initial: true },
  ],
};

test('归一化合法请求：裁掉未知字段，保留类型与 select initial', () => {
  const out = normalizeFormRequest({
    ...VALID,
    extra: 'x',
    fields: [...VALID.fields, { type: 'number', key: 'port', label: '端口', min: 0, max: 65535 }],
  });
  assert.equal(out.kind, 'form');
  assert.equal(out.title, '新建分组');
  assert.ok(!('extra' in out));
  assert.equal(out.fields.length, 4);
  assert.deepEqual(out.fields[1], {
    key: 'scope',
    label: '范围',
    type: 'select',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
    initial: 'b',
  });
  assert.deepEqual(out.fields[2], { key: 'notify', label: '通知', type: 'switch', initial: true });
});

test('拒绝未知字段类型、重复 key、非法 key 与空 fields', () => {
  rejects({ ...VALID, fields: [{ type: 'color', key: 'a', label: 'A' }] }, /type 不支持/);
  rejects({ ...VALID, fields: [VALID.fields[0], VALID.fields[0]] }, /key 重复/);
  rejects({ ...VALID, fields: [{ type: 'text', key: '2bad', label: 'A' }] }, /key 必须以字母开头/);
  rejects({ ...VALID, fields: [] }, /fields 至少/);
  rejects(
    { ...VALID, fields: Array.from({ length: 13 }, (_, i) => ({ type: 'text', key: `k${i}`, label: 'A' })) },
    /最多 12/,
  );
});

test('拒绝越界的数字、不在 options 里的 select 初值与空 option value', () => {
  rejects(
    { ...VALID, fields: [{ type: 'number', key: 'port', label: '端口', min: 1, max: 65535, initial: 0 }] },
    /超出 min\/max/,
  );
  rejects({ ...VALID, fields: [{ type: 'number', key: 'port', label: '端口', min: 10, max: 1 }] }, /min 大于 max/);
  rejects(
    {
      ...VALID,
      fields: [{ type: 'select', key: 'a', label: 'A', initial: 'z', options: [{ value: 'a', label: 'A' }] }],
    },
    /不在 options/,
  );
  rejects(
    { ...VALID, fields: [{ type: 'select', key: 'a', label: 'A', options: [{ value: '', label: 'A' }] }] },
    /value/,
  );
});

test('拒绝不是表单请求的东西（kind 不对、非对象、超长标题）', () => {
  rejects({ kind: 'confirm' }, /kind 必须是 form/);
  rejects(null, /不是对象/);
  rejects({ ...VALID, title: 'x'.repeat(121) }, /不能超过 120/);
});
