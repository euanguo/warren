import { useEffect, useState } from 'react';
import { CommandBarCard } from '@/app/overlay-command-bar';
import { FormCard } from '@/app/overlay-form';
import { ConfirmCard, CreateEnvCard, EditEnvCard } from '@/app/overlay-dialogs';
import { useStandaloneThemeSync } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { OverlayRequest } from '@shared/types';

/**
 * OverlayHost 的独立渲染入口（加载 `index.html?surface=overlay`）。
 * 常驻预热在 WindowLayerManager 最顶层 `'overlay'` 槽位，弹窗零延迟且不藏底层网页。
 */
export function OverlayRoot() {
  useStandaloneThemeSync();
  const [request, setRequest] = useState<OverlayRequest | null>(null);

  useEffect(() => {
    void window.envApi.getOverlayState().then(setRequest);
    return window.envApi.onOverlayState(setRequest);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && request) {
        event.preventDefault();
        void window.envApi.resolveOverlay(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [request]);

  if (!request) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 flex justify-center p-4',
        request.kind === 'command-bar' ? 'items-start pt-[112px]' : 'items-center',
      )}
    >
      <button
        type="button"
        aria-label="关闭浮层"
        tabIndex={-1}
        onClick={() => void window.envApi.resolveOverlay(null)}
        className="fixed inset-0 cursor-default bg-dialog-overlay backdrop-blur-[var(--blur-dialog)]"
      />
      {request.kind === 'create-env' && <CreateEnvCard initialGroupId={request.initialGroupId} />}
      {request.kind === 'edit-env' && <EditEnvCard environment={request.environment} />}
      {request.kind === 'form' && <FormCard request={request} />}
      {request.kind === 'confirm' && (
        <ConfirmCard
          title={request.title}
          description={request.description}
          confirmLabel={request.confirmLabel}
          destructive={request.destructive}
        />
      )}
      {request.kind === 'command-bar' && <CommandBarCard initialQuery={request.initialQuery} />}
    </div>
  );
}
