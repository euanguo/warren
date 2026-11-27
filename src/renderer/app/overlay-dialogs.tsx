import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { elevatedDialogSurfaceClass } from '@/theme/surface';
import type { Environment } from '@shared/types';

const DEFAULT_START_URL = 'https://example.com';

export function OverlayCard({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <dialog
      open
      aria-modal="true"
      className={cn(
        elevatedDialogSurfaceClass,
        'warren-dialog-enter relative z-10 m-0 grid w-full max-w-[440px] gap-0 border-0 p-5 text-[13px] outline-none',
      )}
    >
      <div className="flex flex-col gap-1.5 pr-6">
        <h2 className="text-base leading-none font-medium text-foreground">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <IconButton
        className="absolute top-3 right-3 text-subtle-foreground hover:bg-surface-hover hover:text-foreground"
        title="关闭"
        aria-label="关闭弹窗"
        onClick={onClose}
      >
        <Icon name="X" />
      </IconButton>
      {children}
    </dialog>
  );
}

const ENV_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function slugifyEnvId(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  if (ascii && ascii !== '.' && ascii !== '..') return ascii.slice(0, 32);
  if (!raw.trim()) return '';
  let hash = 0;
  for (const ch of raw.trim()) hash = ((hash << 5) - hash + ch.codePointAt(0)!) | 0;
  return `env-${Math.abs(hash).toString(36).slice(0, 6)}`;
}

export function CreateEnvCard({ initialGroupId }: { initialGroupId?: string }) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idManual, setIdManual] = useState(false);
  const [proxy, setProxy] = useState('');
  const [startUrl, setStartUrl] = useState(DEFAULT_START_URL);
  const [headed, setHeaded] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const effectiveId = (idManual ? id : slugifyEnvId(name)).trim();
  const idInvalid =
    Boolean(effectiveId) && (!ENV_ID_RE.test(effectiveId) || effectiveId === '.' || effectiveId === '..');

  const cancel = () => void window.envApi.resolveOverlay(null);

  const submit = async () => {
    if (!effectiveId || idInvalid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await window.envApi.create({
        id: effectiveId,
        name: name.trim() || effectiveId,
        proxy: proxy.trim() || undefined,
        startUrl: startUrl.trim() || undefined,
        headed,
      });
      if (initialGroupId) {
        await window.envApi.moveToGroup(created.id, initialGroupId);
      }
      await window.envApi.resolveOverlay(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <OverlayCard title="新建环境" description="一个环境 = 独立浏览器存储 + 独立出口。" onClose={cancel}>
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="overlay-new-env-name">环境名称</FieldLabel>
          <Input
            ref={nameRef}
            id="overlay-new-env-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 店铺主号 / alpha"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-new-env-id">环境 ID（CLI 与目录标识）</FieldLabel>
          <Input
            id="overlay-new-env-id"
            value={idManual ? id : effectiveId}
            onChange={(event) => {
              setIdManual(true);
              setId(event.target.value.toLowerCase());
            }}
            placeholder="例如 alpha（自动根据名称生成，可自定义）"
            className="font-mono text-xs"
          />
          {idInvalid && (
            <p className="text-[11px] text-destructive">
              仅支持以小写字母或数字开头，包含小写字母、数字、点、下划线或短横线。
            </p>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-new-env-proxy">代理</FieldLabel>
          <Input
            id="overlay-new-env-proxy"
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="http://host:port（留空直连）"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-new-env-start-url">启动 URL</FieldLabel>
          <Input
            id="overlay-new-env-start-url"
            value={startUrl}
            onChange={(event) => setStartUrl(event.target.value)}
            placeholder={DEFAULT_START_URL}
          />
        </Field>
        <Field orientation="horizontal">
          <Switch id="overlay-new-env-headed" checked={headed} onCheckedChange={setHeaded} />
          <FieldLabel htmlFor="overlay-new-env-headed">启动后自动切换到这个环境</FieldLabel>
        </Field>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
      <div className="flex justify-end gap-2 border-t border-border pt-3.5">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button onClick={() => void submit()} disabled={!effectiveId || idInvalid || submitting}>
          创建
        </Button>
      </div>
    </OverlayCard>
  );
}

export function EditEnvCard({ environment }: { environment: Environment }) {
  const [name, setName] = useState(environment.name);
  const [proxy, setProxy] = useState(environment.proxy ?? '');
  const [startUrl, setStartUrl] = useState(environment.startUrl ?? '');
  const [headed, setHeaded] = useState(environment.headed);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => void window.envApi.resolveOverlay(null);

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await window.envApi.update(environment.id, {
        name: trimmedName,
        proxy: proxy.trim(),
        startUrl: startUrl.trim(),
        headed,
      });
      await window.envApi.resolveOverlay(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <OverlayCard
      title="编辑环境"
      description={
        <>
          <code>{environment.id}</code>
          {environment.status === 'running' && ' · 正在运行：代理、启动 URL 与「自动切换」下次启动才生效'}
        </>
      }
      onClose={cancel}
    >
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor="overlay-edit-env-name">显示名</FieldLabel>
          <Input
            ref={nameRef}
            id="overlay-edit-env-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={environment.id}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-edit-env-proxy">代理</FieldLabel>
          <Input
            id="overlay-edit-env-proxy"
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            placeholder="http://host:port（留空直连）"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="overlay-edit-env-start-url">启动 URL</FieldLabel>
          <Input
            id="overlay-edit-env-start-url"
            value={startUrl}
            onChange={(event) => setStartUrl(event.target.value)}
            placeholder="https://example.com"
          />
        </Field>
        <Field orientation="horizontal">
          <Switch id="overlay-edit-env-headed" checked={headed} onCheckedChange={setHeaded} />
          <FieldLabel htmlFor="overlay-edit-env-headed">启动后自动切换到这个环境</FieldLabel>
        </Field>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
      <div className="flex justify-end gap-2 border-t border-border pt-3.5">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button onClick={() => void submit()} disabled={!name.trim() || submitting}>
          保存
        </Button>
      </div>
    </OverlayCard>
  );
}

export function ConfirmCard({
  title,
  description,
  confirmLabel = '确认',
  destructive = false,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
}) {
  const cancel = () => void window.envApi.resolveOverlay(false);
  return (
    <OverlayCard title={title} description={description} onClose={cancel}>
      <div className="mt-5 flex justify-end gap-2 border-t border-border pt-3.5">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button
          variant={destructive ? 'destructive' : 'default'}
          onClick={() => void window.envApi.resolveOverlay(true)}
        >
          {confirmLabel}
        </Button>
      </div>
    </OverlayCard>
  );
}
