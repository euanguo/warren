import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initialValue: string;
  onSubmit: (value: string) => void;
}

/**
 * 改名弹窗，环境和分组共用——两者只差标题和字段名。
 *
 * 原来是在行里插一个输入框：分组那个还行，环境那个嵌在 `<button>` 里（无效结构），
 * 而且名字一变长整行都在抖。统一到弹窗里，行只剩展示。
 */
export function RenameDialog({ open, onOpenChange, title, label, initialValue, onSubmit }: Props) {
  const [value, setValue] = useState(initialValue);
  // base-ui 自己管初始焦点，`autoFocus` 会被它盖掉，得把 ref 交给它
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * 每次打开都拿当前名字重新填。挂在 `open` 上而不是 `onOpenChange`——父组件直接改 open
   * 不会回调它，只有 Esc / 遮罩 / 关闭按钮才走那条路。
   *
   * 重置放在**渲染期**：React 官方的「prop 变了就重置 state」写法。放 effect 里会先渲染
   * 旧值再纠正一次（多一轮级联渲染），而且用户正在打字时 initialValue 一变就会盖掉输入。
   */
  const [openedFor, setOpenedFor] = useState(open);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) setValue(initialValue);
  }

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const submit = () => {
    const next = value.trim();
    if (!next) return;
    onSubmit(next);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="rename-value">{label}</FieldLabel>
            <Input ref={inputRef} id="rename-value" value={value} onChange={(event) => setValue(event.target.value)} />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
