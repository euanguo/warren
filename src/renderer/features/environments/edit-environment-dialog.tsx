import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { Environment } from '@shared/types';

export interface EnvironmentEdit {
  name: string;
  proxy: string;
  startUrl: string;
  headed: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment?: Environment;
  onSubmit: (id: string, patch: EnvironmentEdit) => void;
}

/**
 * 编辑环境。
 *
 * 为什么要有它：代理 / 启动 URL / 自动切换以前**只有创建那一刻能填**，之后只能敲
 * `warren env update`。右键菜单里那个「重命名…」只改显示名，用户找不到改代理的地方。
 *
 * 环境 id 不可改（它是 session 目录名、CLI 寻址、库里的主键），所以放描述里只读展示，
 * 不占一个字段。
 *
 * **审批策略不在这里** —— 它是跨环境的策略，在「设置 → 审批」一页里统一管，
 * 两处都能改同一个字段只会让人不确定哪个生效。
 */
export function EditEnvironmentDialog({ open, onOpenChange, environment, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [proxy, setProxy] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [headed, setHeaded] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);

  /*
   * 每次打开按当前环境重新填。放在**渲染期**（React 官方的「prop 变了就重置 state」写法）：
   * 挂 `onOpenChange` 不行——父组件直接改 open 不会回调它；放 effect 里会先渲染上一次的值
   * 再纠正一次，正好是这里要避免的那一帧。同 create-environment-dialog。
   */
  const [openedFor, setOpenedFor] = useState(open);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open && environment) {
      setName(environment.name);
      setProxy(environment.proxy ?? '');
      setStartUrl(environment.startUrl ?? '');
      setHeaded(environment.headed);
    }
  }

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const submit = () => {
    if (!environment || !name.trim()) return;
    onSubmit(environment.id, { name: name.trim(), proxy: proxy.trim(), startUrl: startUrl.trim(), headed });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑环境</DialogTitle>
          <DialogDescription>
            <code>{environment?.id}</code>
            {environment?.status === 'running' && ' · 正在运行：代理、启动 URL 与「自动切换」下次启动才生效'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="edit-env-name">显示名</FieldLabel>
            <Input
              ref={nameRef}
              id="edit-env-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={environment?.id}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-env-proxy">代理</FieldLabel>
            <Input
              id="edit-env-proxy"
              value={proxy}
              onChange={(event) => setProxy(event.target.value)}
              placeholder="http://host:port（留空直连）"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="edit-env-start-url">启动 URL</FieldLabel>
            <Input
              id="edit-env-start-url"
              value={startUrl}
              onChange={(event) => setStartUrl(event.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          {/* 关掉之后 `env start` 不抢当前视图：一次拉起好几个环境时界面不会被刷来刷去 */}
          <Field orientation="horizontal">
            <Switch id="edit-env-headed" checked={headed} onCheckedChange={setHeaded} />
            <FieldLabel htmlFor="edit-env-headed">启动后自动切换到这个环境</FieldLabel>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
