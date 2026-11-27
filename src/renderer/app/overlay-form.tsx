import { useEffect, useRef, useState } from 'react';
import { OverlayCard } from '@/app/overlay-dialogs';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { OverlayFormField, OverlayFormRequest, OverlayFormValues } from '@shared/types';

type Draft = Record<string, string | boolean>;

function initialDraft(fields: OverlayFormField[]): Draft {
  const draft: Draft = {};
  for (const field of fields) {
    if (field.type === 'switch') draft[field.key] = field.initial ?? false;
    else if (field.type === 'select') draft[field.key] = field.initial ?? field.options[0]?.value ?? '';
    else if (field.type === 'number') draft[field.key] = field.initial === undefined ? '' : String(field.initial);
    else draft[field.key] = field.initial ?? '';
  }
  return draft;
}

/** 返回 [值, 错误]；错误为 null 表示这一项可以提交。 */
function readField(field: OverlayFormField, draft: Draft): [string | number | boolean, string | null] {
  const raw = draft[field.key];
  if (field.type === 'switch') return [raw === true, null];
  const value = typeof raw === 'string' ? raw : '';
  if (field.type === 'select') return [value, null];
  if (field.type === 'number') {
    const trimmed = value.trim();
    if (!trimmed) return [field.required ? 0 : '', field.required ? '必填' : null];
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return [0, '请输入数字'];
    if (field.min !== undefined && parsed < field.min) return [parsed, `不能小于 ${field.min}`];
    if (field.max !== undefined && parsed > field.max) return [parsed, `不能大于 ${field.max}`];
    return [parsed, null];
  }
  if (field.required && !value.trim()) return [value, '必填'];
  return [value, null];
}

export function FormCard({ request }: { request: OverlayFormRequest }) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(request.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => firstRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const cancel = () => void window.envApi.resolveOverlay(null);

  const submit = () => {
    const values: OverlayFormValues = {};
    const nextErrors: Record<string, string> = {};
    for (const field of request.fields) {
      const [value, error] = readField(field, draft);
      values[field.key] = value;
      if (error) nextErrors[field.key] = error;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void window.envApi.resolveOverlay(values);
  };

  const firstFieldKey = request.fields.find((field) => field.type !== 'switch')?.key;
  const setValue = (key: string, value: string | boolean) => setDraft((current) => ({ ...current, [key]: value }));

  const description = [request.description, request.source ? `来自 ${request.source}` : ''].filter(Boolean).join(' · ');

  return (
    <OverlayCard title={request.title} description={description || undefined} onClose={cancel}>
      <form
        className="flex flex-col gap-4 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {request.fields.map((field) => {
          const error = errors[field.key];
          const ref =
            field.key === firstFieldKey
              ? (node: HTMLInputElement | HTMLTextAreaElement | null) => {
                  firstRef.current = node;
                }
              : undefined;

          return (
            <Field key={field.key} data-invalid={error ? true : undefined}>
              {field.type === 'switch' ? (
                <div className="flex items-start gap-3">
                  <Switch
                    id={`overlay-form-${field.key}`}
                    checked={draft[field.key] === true}
                    onCheckedChange={(checked) => setValue(field.key, checked)}
                  />
                  <div className="flex flex-col gap-1">
                    <FieldLabel htmlFor={`overlay-form-${field.key}`}>{field.label}</FieldLabel>
                    {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
                  </div>
                </div>
              ) : (
                <FieldLabel htmlFor={`overlay-form-${field.key}`}>{field.label}</FieldLabel>
              )}
              {field.type === 'text' && (
                <Input
                  ref={ref}
                  id={`overlay-form-${field.key}`}
                  value={typeof draft[field.key] === 'string' ? (draft[field.key] as string) : ''}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                  onChange={(event) => setValue(field.key, event.target.value)}
                />
              )}
              {field.type === 'textarea' && (
                <Textarea
                  ref={ref}
                  id={`overlay-form-${field.key}`}
                  value={typeof draft[field.key] === 'string' ? (draft[field.key] as string) : ''}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                  onChange={(event) => setValue(field.key, event.target.value)}
                />
              )}
              {field.type === 'number' && (
                <Input
                  ref={ref}
                  id={`overlay-form-${field.key}`}
                  type="number"
                  inputMode="decimal"
                  value={typeof draft[field.key] === 'string' ? (draft[field.key] as string) : ''}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  onChange={(event) => setValue(field.key, event.target.value)}
                />
              )}
              {field.type === 'select' && (
                <Select
                  value={typeof draft[field.key] === 'string' ? (draft[field.key] as string) : ''}
                  onValueChange={(value) => setValue(field.key, String(value ?? ''))}
                >
                  <SelectTrigger id={`overlay-form-${field.key}`}>
                    <SelectValue>
                      {(value) => field.options.find((option) => option.value === value)?.label ?? ''}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {field.options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          );
        })}
      </form>
      <div className="flex justify-end gap-2 border-t border-border pt-3.5">
        <Button variant="ghost" onClick={cancel}>
          {request.cancelLabel ?? '取消'}
        </Button>
        <Button variant={request.destructive ? 'destructive' : 'default'} onClick={submit}>
          {request.submitLabel ?? '确定'}
        </Button>
      </div>
    </OverlayCard>
  );
}
