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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string) => void;
}

/** 新建分组。和新建环境同一个形状：字段在弹窗里填，状态归弹窗自己。 */
export function CreateGroupDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState('');
  // base-ui 自己管初始焦点，`autoFocus` 会被它盖掉，得把 ref 交给它
  const inputRef = useRef<HTMLInputElement>(null);

  // 同 create-environment-dialog：清空挂在 open 上（渲染期重置，见那边的说明），不挂 onOpenChange
  const [openedFor, setOpenedFor] = useState(open);
  if (open !== openedFor) {
    setOpenedFor(open);
    if (open) setName('');
  }

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建分组</DialogTitle>
          <DialogDescription>分组只影响侧栏的组织方式，不影响运行时。</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="new-group-name">分组名</FieldLabel>
            <Input
              ref={inputRef}
              id="new-group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="生产"
            />
          </Field>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
