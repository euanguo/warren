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
        success: <Icon name="CheckCircle" className="size-4" />,
        info: <Icon name="Info" className="size-4" />,
        warning: <Icon name="AlertTriangle" className="size-4" />,
        error: <Icon name="CancelCircle" className="size-4" />,
        loading: <Icon name="Loading" className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
