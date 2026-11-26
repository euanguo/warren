import type { AxNode, SiteNote } from '../../../shared/types.ts';

const INTERACTIVE_ROLE_RE =
  /^(button|link|textbox|checkbox|radio|combobox|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|searchbox|spinbutton|option)$/i;

const KEY_SEMANTIC_ROLE_RE = /^(heading|alert|status|dialog)$/i;

export interface CompactSnapshotOptions {
  url: string;
  title: string;
  nodes: AxNode[];
  siteNotes?: SiteNote[];
  interactiveOnly?: boolean;
  maxDepth?: number;
  maxNodes?: number;
}

function cleanText(raw?: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteText(raw: string): string {
  const shortened = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  return JSON.stringify(shortened);
}

function stateFlagsFor(node: AxNode): string[] {
  const flags: string[] = [];
  if (node.value !== undefined && node.value !== '') flags.push(`value=${quoteText(cleanText(node.value))}`);
  if (node.checked === true) flags.push('checked');
  else if (node.checked === 'mixed') flags.push('checked=mixed');
  if (node.selected) flags.push('selected');
  if (node.expanded !== undefined) flags.push(node.expanded ? 'expanded' : 'collapsed');
  if (node.pressed === true) flags.push('pressed');
  else if (node.pressed === 'mixed') flags.push('pressed=mixed');
  if (node.disabled) flags.push('disabled');
  if (node.readonly) flags.push('readonly');
  if (node.required) flags.push('required');
  if (node.focused) flags.push('focused');
  if (node.level !== undefined) flags.push(`level=${node.level}`);
  return flags;
}

/**
 * 将 AX 节点数组格式化为极简文本树（`- button "提交" [ref=@3]`），
 * 大幅削减上下文 Token，并在命中域名/路径时自动注入 `# site-notes`。
 */
export function formatCompactSnapshot(options: CompactSnapshotOptions): string {
  const lines: string[] = [];
  if (options.siteNotes && options.siteNotes.length > 0) {
    lines.push('# site-notes');
    for (const note of options.siteNotes) {
      for (const noteLine of note.content.split(/\r?\n/)) {
        const trimmed = noteLine.trim();
        if (trimmed) lines.push(`- [${note.site}] ${trimmed}`);
      }
    }
    lines.push('');
  }

  lines.push(`url: ${options.url}`);
  if (options.title) lines.push(`title: ${cleanText(options.title)}`);

  const maxDepth = options.maxDepth;
  const maxNodes = options.maxNodes && options.maxNodes > 0 ? options.maxNodes : 400;
  let emitted = 0;

  for (const node of options.nodes) {
    const isInteractive = INTERACTIVE_ROLE_RE.test(node.role);
    const isSemantic = KEY_SEMANTIC_ROLE_RE.test(node.role);
    if (options.interactiveOnly && !isInteractive) continue;
    if (!options.interactiveOnly && !isInteractive && !isSemantic && !cleanText(node.name)) continue;
    if (maxDepth !== undefined && node.level !== undefined && node.level > maxDepth) continue;

    const name = cleanText(node.name);
    const namePart = name ? ` ${quoteText(name)}` : '';
    const flags = stateFlagsFor(node);
    if (node.ref) flags.push(`ref=${node.ref}`);
    const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    lines.push(`- ${node.role}${namePart}${suffix}`);
    emitted += 1;
    if (emitted >= maxNodes) {
      lines.push(`... (truncated at ${maxNodes} nodes)`);
      break;
    }
  }

  if (emitted === 0) lines.push('(no matching nodes)');
  return lines.join('\n');
}
