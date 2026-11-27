import * as React from 'react';
import { toast } from 'sonner';
import { Icon } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import { StatusDot, StatusMark } from '@/components/ui/status-dot';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  SettingsSection,
} from '@/components/ui/item-group';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ListRow,
  ListRowActionButton,
  ListRowActions,
  ListRowLabel,
  ListRowLabelText,
  ListRowMain,
  ListRowMeta,
} from '@/components/ui/list-row';
import {
  cardSurfaceClass,
  controlFieldClass,
  elevatedMenuSurfaceClass,
  menuItemInteractiveClass,
} from '@/theme/surface';
import { cn } from '@/lib/utils';

// 保留 React 命名空间引用提示，确保插件环境与宿主共享一致的 JSX/createElement 契约。
export type PluginReact = typeof React;

/**
 * 插件能用的宿主 UI —— **单一出口**。
 *
 * 为什么要有它：插件 bundle 是独立的一份 ESM，走 `warren-plugin://` 供给，**import 不到宿主的
 * 模块图**（`@/components/ui/*` 对它是不可见的）。没有这层，插件只能手写 `<div className="rounded-md
 * border border-border">` —— 那等于每个插件自己抄一遍设计契约，token / recipe / 角形状全绕过了。
 *
 * 规矩（和宿主自己的组件用法一致，见 `components/ui/README.md`）：
 * - 用这里的组件，**不要**自己拼 chrome；要特殊布局就用 `cn` 拼 Tailwind 工具类。
 * - 几何 / 颜色只从组件和 recipe（`cardSurfaceClass` / `controlFieldClass`）来，不写死 hex / `h-8`。
 * - 这份清单就是**兼容面**：插件只能拿到这里有的东西，加东西是加法，改/删要走 `apiVersion`。
 *
 * 这是 renderer 与插件之间的边界，所以留在渲染层而非 `shared/`——它不过 RPC。
 */
export const PLUGIN_UI = {
  // 工具
  cn,
  toast,
  cardSurfaceClass,
  controlFieldClass,
  elevatedMenuSurfaceClass,
  menuItemInteractiveClass,
  // 图标（`components/icons.tsx` 是图标单源，插件不引图标包）
  Icon,
  // 基础控件
  Button,
  IconButton,
  Input,
  Textarea,
  Switch,
  Checkbox,
  Badge,
  Kbd,
  StatusDot,
  StatusMark,
  Separator,
  Spinner,
  Alert,
  AlertTitle,
  AlertDescription,
  // 卡片与分栏
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  SettingsSection,
  ItemGroup,
  Item,
  ItemMedia,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  // 表单
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  // 对话框
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  // 确认框（破坏性操作用它，别用 Dialog 自己拼）
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  // 选择器
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
  // 菜单
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  // 提示
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  // 容器
  ScrollArea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  // 列表行（插件面板里的行用它，别手写 hover / 选中态）
  ListRow,
  ListRowMain,
  ListRowLabel,
  ListRowLabelText,
  ListRowMeta,
  ListRowActions,
  ListRowActionButton,
} as const;

export type PluginUi = typeof PLUGIN_UI;
