import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FormCard } from '@/app/overlay-form';
import type { OverlayFormRequest } from '@shared/types';
import { installMockEnvApi } from './setup';

const REQUEST: OverlayFormRequest = {
  kind: 'form',
  title: '新建分组',
  submitLabel: '创建',
  source: '测试插件',
  fields: [
    { type: 'text', key: 'name', label: '分组名', required: true },
    { type: 'number', key: 'port', label: '端口', min: 0, max: 65535 },
    { type: 'switch', key: 'notify', label: '创建后通知', initial: true },
  ],
};

describe('声明式表单', () => {
  beforeEach(() => {
    installMockEnvApi();
  });

  it('必填为空时拦下并按字段报错，不提交', async () => {
    render(<FormCard request={REQUEST} />);
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText('必填')).toBeTruthy();
    expect(window.envApi.resolveOverlay).not.toHaveBeenCalled();
  });

  it('提交按类型交值：number 是数字、空数字是空串、switch 是布尔', async () => {
    render(<FormCard request={REQUEST} />);
    fireEvent.change(screen.getByLabelText('分组名'), { target: { value: '生产' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() =>
      expect(window.envApi.resolveOverlay).toHaveBeenCalledWith({ name: '生产', port: '', notify: true }),
    );
  });

  it('带初始值的字段预填，提交时类型不丢', () => {
    render(
      <FormCard
        request={{
          kind: 'form',
          title: '重命名分组',
          fields: [
            { type: 'text', key: 'name', label: '名字', initial: '生产' },
            { type: 'number', key: 'port', label: '端口', initial: 8080 },
            {
              type: 'select',
              key: 'mode',
              label: '模式',
              initial: 'b',
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
            },
            { type: 'switch', key: 'on', label: '开关', initial: true },
          ],
        }}
      />,
    );
    expect((screen.getByLabelText('名字') as HTMLInputElement).value).toBe('生产');
    expect((screen.getByLabelText('端口') as HTMLInputElement).value).toBe('8080');
    expect(screen.getByText('B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    expect(window.envApi.resolveOverlay).toHaveBeenCalledWith({ name: '生产', port: 8080, mode: 'b', on: true });
  });

  it('取消回 null，并显示插件来源', () => {
    render(<FormCard request={REQUEST} />);
    expect(screen.getByText(/来自 测试插件/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(window.envApi.resolveOverlay).toHaveBeenCalledWith(null);
  });
});
