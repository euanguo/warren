import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { CredentialSummary } from '@shared/types';

/** 设置里的「凭据与安全边界」页：只列引用和打码用户名，表单直通主进程 Keychain 永不回传明文。 */
export function VaultPanel() {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [available, setAvailable] = useState(true);
  const [tick, setTick] = useState(0);

  const [provider, setProvider] = useState('proxy');
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const vault = await window.envApi.vault();
      if (cancelled) return;
      setCredentials(vault.credentials);
      setAvailable(vault.available);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const remove = async (ref: string) => {
    try {
      await window.envApi.vaultRemove(ref);
      setTick((value) => value + 1);
      toast.success('已删除凭据');
    } catch (error) {
      toast.error('删除凭据失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const addCredential = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) {
      toast.error('请填写标签（代理请填 host:port，如 127.0.0.1:8899）');
      return;
    }
    if (!username.trim() && !password && !token.trim()) {
      toast.error('用户名、密码与 Token 至少填写一项');
      return;
    }
    setSaving(true);
    try {
      const summary = await window.envApi.vaultAdd({
        provider,
        label: label.trim(),
        username: username.trim() || undefined,
        password: password || undefined,
        token: token.trim() || undefined,
      });
      setLabel('');
      setUsername('');
      setPassword('');
      setToken('');
      setTick((value) => value + 1);
      toast.success(`凭据已安全写入 Keychain：${summary.ref}`);
    } catch (error) {
      toast.error('新增凭据失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Alert>
        <Icon name="Shield" className="size-4" />
        <AlertTitle>安全边界：Vault 绝不暴露明文</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed">
          <span>
            密码通过系统 Keychain / Electron <code className="font-mono">safeStorage</code> 加密存储。外部 Agent
            与插件仅能获取 <code className="font-mono">vault://...</code>{' '}
            引用与打码账号提示；填入页面或代理认证时由主进程直接投递，不回流渲染层。
          </span>
        </AlertDescription>
      </Alert>

      <form onSubmit={(event) => void addCredential(event)} className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">快速录入加密凭据</span>
          {!available && (
            <Badge variant="outline" className="border-destructive/50 text-destructive">
              系统密钥存储不可用
            </Badge>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Select value={provider} onValueChange={(value) => setProvider(String(value))}>
            <SelectTrigger size="sm">
              <SelectValue>{(value) => (value === 'proxy' ? '代理认证 (proxy)' : '网页登录 (login)')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="proxy">代理认证 (proxy)</SelectItem>
              <SelectItem value="login">网页登录 (login)</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={provider === 'proxy' ? '代理 host:port（如 127.0.0.1:8899）' : '用途或站点域名'}
            disabled={!available || saving}
          />
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="用户名 / 账号"
            autoComplete="off"
            disabled={!available || saving}
          />
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="密码（提交后即刻清空）"
            autoComplete="new-password"
            disabled={!available || saving}
          />
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="可选 Token / API Key"
            autoComplete="new-password"
            disabled={!available || saving}
            className="flex-1"
          />
          <Button type="submit" size="sm" disabled={!available || saving}>
            <Icon name="Key" /> {saving ? '写入中…' : '加密保存'}
          </Button>
        </div>
      </form>

      <div className={cn(cardSurfaceClass, 'flex flex-col gap-3')}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">已保存凭据（{credentials.length}）</span>
        </div>

        {credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            还没有凭据。可在上方表单录入，或在终端执行 <code className="font-mono">warren vault add</code>（从 stdin
            读入避免进历史记录）。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {credentials.map((credential) => (
              <div
                key={credential.ref}
                className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    <span className="truncate">{credential.label}</span>
                    <span className="text-muted-foreground">
                      {credential.provider}
                      {credential.usernameHint ? ` · ${credential.usernameHint}` : ''}
                    </span>
                    {!credential.available && (
                      <Badge
                        variant="outline"
                        className="border-destructive/50 text-destructive"
                        title="这条凭据是用旧密钥加密的，已经解不开了。删掉重新添加。"
                      >
                        密钥已失效
                      </Badge>
                    )}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{credential.ref}</span>
                </div>
                <IconButton title="删除凭据" aria-label="删除凭据" onClick={() => void remove(credential.ref)}>
                  <Icon name="Trash" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
