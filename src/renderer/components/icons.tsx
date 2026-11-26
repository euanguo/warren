/**
 * 图标单源（Hugeicons）。
 *
 * 架构照抄 bb 的 `packages/shared-ui/src/components/ui/icon.tsx`：
 * - **语义名注册表**：业务侧只写 `<Icon name="PanelLeft" />`，不直接 import 图标包。
 *   换图标库时只改这一个文件。
 * - **data-icon-root**：每个图标根节点都带这个属性，尺寸可以由父元素统一控制，
 *   例如 `[&_[data-icon-root]]:size-3.5`（父选择器的优先级高于自身的 `size-4`）。
 * - **fallback**：请求的名字不存在时退到 `fallback`（默认 `Zap`），不静默渲染成空白。
 *
 * 尺寸：默认 `size-4`（16px）。Hugeicons 是 24 格 + stroke 1.5，缩到 16px 后
 * 有效描边 ≈ 1.0px —— 与迁移前的 Tabler（24 格 stroke 1.5 → 16px）观感一致，
 * 所以换库不需要重新调描边。
 */
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import Activity01Icon from '@hugeicons/core-free-icons/Activity01Icon';
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon';
import AppWindowIcon from '@hugeicons/core-free-icons/AppWindowIcon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon';
import Bug01Icon from '@hugeicons/core-free-icons/Bug01Icon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon';
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon';
import CodeIcon from '@hugeicons/core-free-icons/CodeIcon';
import CommandIcon from '@hugeicons/core-free-icons/CommandIcon';
import ComputerIcon from '@hugeicons/core-free-icons/ComputerIcon';
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon';
import CornerUpLeftIcon from '@hugeicons/core-free-icons/CornerUpLeftIcon';
import Cursor02Icon from '@hugeicons/core-free-icons/Cursor02Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import Download01Icon from '@hugeicons/core-free-icons/Download01Icon';
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon';
import ExternalLinkIcon from '@hugeicons/core-free-icons/ExternalLinkIcon';
import FloppyDiskIcon from '@hugeicons/core-free-icons/FloppyDiskIcon';
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon';
import FolderAddIcon from '@hugeicons/core-free-icons/FolderAddIcon';
import FolderMinusIcon from '@hugeicons/core-free-icons/FolderMinusIcon';
import FolderOpenIcon from '@hugeicons/core-free-icons/FolderOpenIcon';
import GlobeIcon from '@hugeicons/core-free-icons/GlobeIcon';
import HandGrabIcon from '@hugeicons/core-free-icons/HandGrabIcon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import Key01Icon from '@hugeicons/core-free-icons/Key01Icon';
import LaptopIcon from '@hugeicons/core-free-icons/LaptopIcon';
import LayoutBottomIcon from '@hugeicons/core-free-icons/LayoutBottomIcon';
import LayoutRightIcon from '@hugeicons/core-free-icons/LayoutRightIcon';
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon';
import LockIcon from '@hugeicons/core-free-icons/LockIcon';
import ListBulletIcon from '@hugeicons/core-free-icons/LeftToRightListBulletIcon';
import MonitorSmartphoneIcon from '@hugeicons/core-free-icons/MonitorSmartphoneIcon';
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon';
import Package01Icon from '@hugeicons/core-free-icons/Package01Icon';
import PanelLeftCloseIcon from '@hugeicons/core-free-icons/PanelLeftCloseIcon';
import PanelLeftOpenIcon from '@hugeicons/core-free-icons/PanelLeftOpenIcon';
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon';
import PlusIcon from '@hugeicons/core-free-icons/PlusIcon';
import PrinterIcon from '@hugeicons/core-free-icons/PrinterIcon';
import PuzzleIcon from '@hugeicons/core-free-icons/PuzzleIcon';
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon';
import Robot01Icon from '@hugeicons/core-free-icons/Robot01Icon';
import RotateClockwiseIcon from '@hugeicons/core-free-icons/RotateClockwiseIcon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import ShieldAlertIcon from '@hugeicons/core-free-icons/ShieldAlertIcon';
import SidebarLeftIcon from '@hugeicons/core-free-icons/SidebarLeftIcon';
import SlidersHorizontalIcon from '@hugeicons/core-free-icons/SlidersHorizontalIcon';
import SmartPhone01Icon from '@hugeicons/core-free-icons/SmartPhone01Icon';
import SparklesIcon from '@hugeicons/core-free-icons/SparklesIcon';
import StopIcon from '@hugeicons/core-free-icons/StopIcon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import UserIcon from '@hugeicons/core-free-icons/UserIcon';
import VolumeHighIcon from '@hugeicons/core-free-icons/VolumeHighIcon';
import VolumeOffIcon from '@hugeicons/core-free-icons/VolumeOffIcon';
import Wrench01Icon from '@hugeicons/core-free-icons/Wrench01Icon';
import ZapIcon from '@hugeicons/core-free-icons/ZapIcon';
import ZoomInIcon from '@hugeicons/core-free-icons/ZoomInIcon';
import ZoomOutIcon from '@hugeicons/core-free-icons/ZoomOutIcon';
import { type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * 语义名 → 图标数据。加图标只改这里。
 * 名字按用途取（`Refresh` 而不是 `Refresh01Icon`），换库时业务代码不用动。
 */
const ICON_MAP = {
  Activity: Activity01Icon,
  AlertTriangle: Alert02Icon,
  Bug: Bug01Icon,
  CancelCircle: CancelCircleIcon,
  Check: Tick02Icon,
  CheckCircle: CheckmarkCircle02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  ChevronUp: ArrowUp01Icon,
  Code: CodeIcon,
  Command: CommandIcon,
  Copy: Copy01Icon,
  Cursor: Cursor02Icon,
  Desktop: ComputerIcon,
  DockBottom: LayoutBottomIcon,
  DockRight: LayoutRightIcon,
  Download: Download01Icon,
  ExternalLink: ExternalLinkIcon,
  ExternalWindow: AppWindowIcon,
  Folder: Folder01Icon,
  FolderMinus: FolderMinusIcon,
  FolderOpen: FolderOpenIcon,
  FolderPlus: FolderAddIcon,
  Globe: GlobeIcon,
  Grab: HandGrabIcon,
  Info: InformationCircleIcon,
  Key: Key01Icon,
  Laptop: LaptopIcon,
  List: ListBulletIcon,
  Loading: Loading03Icon,
  Lock: LockIcon,
  Mobile: SmartPhone01Icon,
  More: MoreHorizontalIcon,
  Package: Package01Icon,
  PanelLeft: SidebarLeftIcon,
  PanelLeftClose: PanelLeftCloseIcon,
  PanelLeftOpen: PanelLeftOpenIcon,
  PanelRight: LayoutRightIcon,
  Pencil: Edit02Icon,
  Play: PlayIcon,
  Plug: PuzzleIcon,
  Plus: PlusIcon,
  Printer: PrinterIcon,
  Refresh: RefreshIcon,
  Release: CornerUpLeftIcon,
  Robot: Robot01Icon,
  RotateClockwise: RotateClockwiseIcon,
  Save: FloppyDiskIcon,
  Search: Search01Icon,
  Settings: Settings01Icon,
  Shield: ShieldAlertIcon,
  Sliders: SlidersHorizontalIcon,
  Sparkles: SparklesIcon,
  Stop: StopIcon,
  Trash: Delete02Icon,
  User: UserIcon,
  Viewport: MonitorSmartphoneIcon,
  Volume: VolumeHighIcon,
  VolumeOff: VolumeOffIcon,
  Wrench: Wrench01Icon,
  X: Cancel01Icon,
  Zap: ZapIcon,
  ZoomIn: ZoomInIcon,
  ZoomOut: ZoomOutIcon,
} as const satisfies Record<string, IconSvgElement>;

export type IconName = keyof typeof ICON_MAP;

export const ICON_NAMES = Object.keys(ICON_MAP) as readonly IconName[];

const ICON_LOOKUP: Readonly<Record<string, IconSvgElement | undefined>> = ICON_MAP;

export function isIconName(name: string): name is IconName {
  return name in ICON_LOOKUP;
}

export interface IconProps {
  /** 语义名。拼错时退到 `fallback`，不会渲染成空白。 */
  name: string;
  fallback?: IconName;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
}

/**
 * 图标。尺寸默认 16px，调用方用 className 覆盖（`size-3.5` 等）。
 * `data-icon` 记语义名，方便在 devtools / 测试里定位是哪个图标。
 */
export function Icon({ name, fallback = 'Zap', className, ...props }: IconProps) {
  const resolved = isIconName(name) ? name : fallback;
  return (
    <HugeiconsIcon
      icon={ICON_LOOKUP[resolved] ?? ICON_MAP.Zap}
      data-icon={resolved}
      data-icon-root=""
      className={cn('size-4 shrink-0', className)}
      {...props}
    />
  );
}
