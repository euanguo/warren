import { Icon } from '@/components/icons';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

// 本应用固定深色，不引入 next-themes
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
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
