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

export interface NewEnvironment {
  id: string;
  proxy?: string;
  startUrl?: string;
  /** 启动后自动把界面切到这个环境（PRD 6.1 的「启动时是否显示窗口」）。默认开。 */
  headed?: boolean;
}

const DEFAULT_START_URL = 'https://example.com';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewEnvironment) => void;
}

/**
 * 新建环境。三个字段在弹窗里填，不再往侧栏列表顶上插一段表单——
 * 那段表单会把列表整个推下去，而且和「环境行」长得很像，容易看错。
 *
 * 表单状态留在弹窗自己身上：它是弹窗的草稿，关掉就该忘掉。
 * 每次打开清空，免得下次打开还留着上一次的半截输入。
 */
export function CreateEnvironmentDialog({ open, onOpenChange, onCreate }: Props) {
  const [id, setId] = useState('');
  const [proxy, setProxy] = useState('');
  const [startUrl, setStartUrl] = useState(DEFAULT_START_URL);
  const [headed, setHeaded] = useState(true);
  // base-ui 自己管初始焦点，`autoFocus` 会被它盖掉，得把 ref 交给它
  const idRef = useRef<HTMLInputElement>(null);

  /*
   * 每次打开清空。不能挂在 `onOpenChange` 上：父组件直接改 open 不会回调它，
   * 只有 Esc / 点遮罩 / 关闭按钮才走那条路。
   *
   * 清空放在**渲染期**（React 官方的「prop 变了就重置 state」写法）：放 effect 里会先渲染
   * 上一次的半截输入再纠正一次，正好是这里要避免的那一帧。
   */
  const [openedFor, setOpenedFor] = useState(open);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) {
      setId('');
      setProxy('');
      setStartUrl(DEFAULT_START_URL);
      setHeaded(true);
    }
  }

  useEffect(() => {
    if (!open) return;
    // 焦点自己送进去：base-ui 的 initialFocus 在这个组合下不生效，焦点会留在触发按钮上，
    // 打开后没法直接打字。
    const frame = requestAnimationFrame(() => idRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const submit = () => {
    if (!id.trim()) return;
    onCreate({
      id: id.trim(),
      proxy: proxy.trim() || undefined,
      startUrl: startUrl.trim() || undefined,
      headed,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建环境</DialogTitle>
          <DialogDescription>一个环境 = 独立浏览器存储 + 独立出口。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="new-env-id">环境名</FieldLabel>
            <Input
              ref={idRef}
              id="new-env-id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="例如 alpha"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-env-proxy">代理</FieldLabel>
            <Input
              id="new-env-proxy"
              value={proxy}
              onChange={(event) => setProxy(event.target.value)}
              placeholder="http://host:port（留空直连）"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-env-start-url">启动 URL</FieldLabel>
            <Input
              id="new-env-start-url"
              value={startUrl}
              onChange={(event) => setStartUrl(event.target.value)}
              placeholder={DEFAULT_START_URL}
            />
          </Field>
          {/* 关掉之后 `env start` 不抢当前视图：一次拉起好几个环境时界面不会被刷来刷去 */}
          <Field orientation="horizontal">
            <Switch id="new-env-headed" checked={headed} onCheckedChange={setHeaded} />
            <FieldLabel htmlFor="new-env-headed">启动后自动切换到这个环境</FieldLabel>
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!id.trim()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
