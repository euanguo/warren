import warrenIcon from '@/assets/warren-icon.png';
import { cn } from '@/lib/utils';

/**
 * 品牌标记 —— 界面里 logo 的单源。
 *
 * 与桌面应用图标（assets/icon.icns / icon.png）同源，供左侧导航栏与空态复用。
 */
export function WarrenMark({ className }: { className?: string }) {
  return <img src={warrenIcon} alt="Warren" draggable={false} className={cn('shrink-0 select-none', className)} />;
}
