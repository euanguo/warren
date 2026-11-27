import { Icon } from '@/components/icons';
import { useResolvedTheme } from '@/lib/theme';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const resolvedTheme = useResolvedTheme();
  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      icons={{
        success: <Icon name="CheckCircle" className="size-4 text-success-text" />,
        info: <Icon name="Info" className="size-4 text-accent-text" />,
        warning: <Icon name="AlertTriangle" className="size-4 text-warning-text" />,
        error: <Icon name="CancelCircle" className="size-4 text-danger-text" />,
        loading: <Icon name="Loading" className="size-4 animate-spin text-muted-foreground" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'rounded-[var(--radius-card)] border-0 bg-popover text-popover-foreground shadow-none [box-shadow:var(--elevation-popover)] text-[13px]',
          description: 'text-[12px] text-muted-foreground',
          actionButton: 'active:scale-[0.96] transition-transform',
          cancelButton: 'active:scale-[0.96] transition-transform',
          closeButton:
            'border-border-strong bg-popover text-muted-foreground hover:bg-control-hover hover:text-foreground',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border-strong)',
          '--border-radius': 'var(--radius-card)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
