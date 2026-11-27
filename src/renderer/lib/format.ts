/**
 * 渲染层共享数值格式化工具：供侧栏、速览浮层、内存面板与下载列表复用，
 * 避免轻量入口反向把完整设置面板打进首屏 chunk。
 */

export function formatMemoryKb(kb: number): string {
  const safe = Number.isFinite(kb) && kb > 0 ? kb : 0;
  const mb = safe / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 100) return `${Math.round(mb)} MB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(safe)} KB`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatIdleSeconds(seconds: number): string {
  if (seconds < 60) return '刚刚活跃';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `闲置 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  return `闲置 ${hours} 小时 ${mins % 60} 分`;
}

export function formatLimitMb(mb: number): string {
  if (mb <= 0) return '不限制';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}
