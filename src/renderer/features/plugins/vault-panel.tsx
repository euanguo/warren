import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cardSurfaceClass } from '@/theme/surface';
import { cn } from '@/lib/utils';
import type { CredentialSummary } from '@shared/types';

/** 设置里的「凭据」一页。只列引用和打码用户名——Vault 没有读明文的通道。 */
export function VaultPanel() {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [available, setAvailable] = useState(true);

  /** 删完凭据重取一次。计数一变 effect 重跑，不用在 effect 外面留一个会 setState 的函数。 */
  const [tick, setTick] = useState(0);
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
    } catch (error) {
      toast.error('删除凭据失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">已保存</span>
        {!available && (
          <Badge variant="outline" className="border-destructive/50 text-destructive">
            系统密钥存储不可用
          </Badge>
        )}
      </div>

      {credentials.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Vault 是空的。用 CLI 添加：<code>warren vault add</code>。
        </p>
      )}

      {credentials.map((credential) => (
        <div key={credential.ref} className={cn(cardSurfaceClass, 'flex items-center justify-between gap-2')}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span className="truncate">
                {credential.provider} · {credential.label}
              </span>
              {/* 旧密钥写的记录解不开：不标出来人会一直拿它去填，然后收到「cannot decrypt」 */}
              {!credential.available && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-[var(--warning)]/50 text-[var(--warning)]"
                  title="用旧密钥加密，已经解不开了；删掉重新添加"
                >
                  不可用
                </Badge>
              )}
            </span>
            <span className="truncate text-xs text-muted-foreground">{credential.usernameHint || '（无用户名）'}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void remove(credential.ref)}>
            删除
          </Button>
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        凭据的密码只在主进程内解密后直接填入页面字段，界面和插件都拿不到明文。
      </p>
    </div>
  );
}
