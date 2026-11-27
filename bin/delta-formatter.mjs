/**
 * 紧凑 AI 可读回执格式器（纯 ESM，零依赖）：
 * 将单步写动作回执与 `warren batch` 结果压缩为高信噪比纯文本，
 * 消灭嵌套 JSON 与双份数据冗余，大幅降低 LLM 上下文 Token 占用。
 */

function quoteShort(raw, maxLen = 80) {
  const cleaned = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 3)}...` : cleaned;
  return JSON.stringify(clipped);
}

function formatItemFlags(item) {
  const flags = [];
  if (item.beforeValue !== undefined && item.value !== undefined && item.beforeValue !== item.value) {
    flags.push(`${quoteShort(item.beforeValue, 40)} -> ${quoteShort(item.value, 40)}`);
  } else if (item.value !== undefined && item.value !== '') {
    flags.push(`value=${quoteShort(item.value, 48)}`);
  }
  if (item.beforeChecked !== undefined && item.checked !== item.beforeChecked) {
    flags.push(`${String(item.beforeChecked)} -> ${String(item.checked)}`);
  } else if (item.checked === true) {
    flags.push('checked');
  } else if (item.checked === 'mixed') {
    flags.push('checked=mixed');
  }
  if (item.beforeDisabled !== undefined && item.disabled !== item.beforeDisabled) {
    flags.push(item.disabled ? 'disabled' : 'enabled');
  } else if (item.disabled) {
    flags.push('disabled');
  }
  if (item.selected) flags.push('selected');
  if (item.ref) flags.push(`ref=${item.ref}`);
  return flags.length > 0 ? ` [${flags.join(', ')}]` : '';
}

function formatContextHints(hints, lines) {
  if (!hints) return;
  if (Array.isArray(hints.siteNotes) && hints.siteNotes.length > 0) {
    lines.push('# site-notes');
    for (const note of hints.siteNotes) {
      for (const row of String(note.content ?? '').split(/\r?\n/)) {
        const trimmed = row.trim();
        if (trimmed) lines.push(`- [${note.site}] ${trimmed}`);
      }
    }
  }
  if (Array.isArray(hints.savedFlows) && hints.savedFlows.length > 0) {
    lines.push('# saved-flows (one-step read-only GET, skips UI)');
    for (const flow of hints.savedFlows) {
      const sig = flow.params?.length ? `(${flow.params.join(', ')})` : '()';
      const desc = flow.description ? ` — ${flow.description}` : '';
      lines.push(`- ${flow.name}${sig}${desc}`);
    }
  }
}

export function formatSideEffectsLines(sideEffects) {
  if (!sideEffects || typeof sideEffects !== 'object') return [];
  const lines = [];
  if (sideEffects.openDialog) {
    const d = sideEffects.openDialog;
    lines.push(
      `[dialog-open] ${d.type}: ${quoteShort(d.message, 120)} (use \`warren browser dialog <env> accept|dismiss\`)`,
    );
  }
  if (Array.isArray(sideEffects.unhandledPopups)) {
    for (const p of sideEffects.unhandledPopups) {
      lines.push(`[unhandled-popup] tab #${p.index}: ${p.url}${p.title ? ` (${quoteShort(p.title, 40)})` : ''}`);
    }
  }
  if (Array.isArray(sideEffects.activeDownloads)) {
    for (const dl of sideEffects.activeDownloads) {
      lines.push(`[download] ${dl.filename || dl.downloadId} (id=${dl.downloadId})`);
    }
  }
  return lines;
}

/** 渲染结构化 `ActionDelta` 为紧凑多行文本。 */
export function formatDeltaSection(delta) {
  if (!delta || typeof delta !== 'object') return [];
  const lines = [];
  formatContextHints(delta.contextHints, lines);

  if (Array.isArray(delta.healed) && delta.healed.length > 0) {
    for (const h of delta.healed) {
      const scope = h.containerScope ? ` in ${h.containerScope}` : '';
      lines.push(`  → healed: ${h.ref} redrawn, matched ${h.role} ${quoteShort(h.name, 50)}${scope}`);
    }
  }

  if (delta.urlChanged || delta.titleChanged || delta.navError) {
    const parts = [];
    if (delta.urlChanged) parts.push(`url -> ${delta.url}`);
    if (delta.titleChanged && delta.title) parts.push(`title: ${quoteShort(delta.title, 70)}`);
    if (delta.navError) parts.push(`nav-error: ${delta.navError}`);
    if (parts.length > 0) lines.push(`  ${parts.join(' | ')}`);
  }

  if (Array.isArray(delta.network) && delta.network.length > 0) {
    for (const net of delta.network.slice(0, 8)) {
      lines.push(`  net: ${net}`);
    }
    if (delta.network.length > 8) {
      lines.push(`  net: ... (+${delta.network.length - 8} more requests)`);
    }
  }

  const nodes = delta.nodes;
  if (nodes) {
    if (Array.isArray(nodes.added)) {
      for (const item of nodes.added.slice(0, 20)) {
        const namePart = item.name ? ` ${quoteShort(item.name, 60)}` : '';
        lines.push(`  + ${item.role}${namePart}${formatItemFlags(item)}`);
      }
      if (nodes.added.length > 20) lines.push(`  + ... (+${nodes.added.length - 20} more added)`);
    }
    if (Array.isArray(nodes.changed)) {
      for (const item of nodes.changed.slice(0, 12)) {
        const namePart = item.name ? ` ${quoteShort(item.name, 60)}` : '';
        lines.push(`  ~ ${item.role}${namePart}${formatItemFlags(item)}`);
      }
      if (nodes.changed.length > 12) lines.push(`  ~ ... (+${nodes.changed.length - 12} more changed)`);
    }
    if (Array.isArray(nodes.removed) && nodes.removed.length > 0) {
      const preview = nodes.removed
        .slice(0, 5)
        .map((r) => `${r.role}${r.name ? ` ${quoteShort(r.name, 30)}` : ''}`)
        .join(', ');
      const more = nodes.removed.length > 5 ? `, +${nodes.removed.length - 5} more` : '';
      lines.push(`  - removed (${nodes.removed.length}): ${preview}${more}`);
    }
    if (Array.isArray(nodes.foldedGroups)) {
      for (const group of nodes.foldedGroups) {
        lines.push(`  ${group}`);
      }
    }
  }

  if (delta.openedText) {
    lines.push(`  text: ${delta.openedText}`);
  }

  lines.push(...formatSideEffectsLines(delta.sideEffects));

  if (delta.loopWarning) {
    lines.push(`[loop-warning] ${delta.loopWarning}`);
  }
  return lines;
}

/** 渲染单步写动作（click / fill / select / open 等）的紧凑回执。 */
export function formatActionResultText(actionLabel, result) {
  if (!result || typeof result !== 'object') {
    return `✓ ${actionLabel}${result !== undefined ? ` -> ${String(result)}` : ''}`;
  }

  const lines = [];
  const metaParts = [];
  if (typeof result.navigation === 'string' && result.navigation !== 'none') {
    metaParts.push(`navigation=${result.navigation}`);
  }
  if (result.cellChange && typeof result.cellChange === 'object') {
    const c = result.cellChange;
    metaParts.push(`gridcell ${quoteShort(c.before, 30)} -> ${quoteShort(c.after, 30)}`);
  }
  if (result.warning?.message) {
    metaParts.push(`warning: ${result.warning.message}`);
  }
  if (typeof result.changed === 'boolean' && result.checked !== undefined) {
    metaParts.push(
      result.changed ? `checked=${String(result.checked)}` : `unchanged (checked=${String(result.checked)})`,
    );
  }

  const delta = result.delta;
  const suffix =
    delta && delta.changed === false ? ' -> no change' : metaParts.length > 0 ? ` (${metaParts.join('; ')})` : '';
  lines.push(`✓ ${actionLabel}${suffix}`);

  if (delta) {
    lines.push(...formatDeltaSection(delta));
  } else {
    // 未启用 delta（如 `--no-changes`）时仍输出即时弹窗/新页/自愈提醒
    if (Array.isArray(result.healed)) {
      for (const h of result.healed) {
        lines.push(`  → healed: ${h.ref} redrawn, matched ${h.role} ${quoteShort(h.name, 50)}`);
      }
    }
    lines.push(
      ...formatSideEffectsLines({
        openDialog: result.dialog ?? null,
        unhandledPopups: result.popups,
        activeDownloads: result.downloads,
      }),
    );
  }

  return lines.join('\n');
}

/** 渲染 `warren batch` 的紧凑文本回执（替代原先全量嵌套 JSON）。 */
export function formatBatchResultText(batchResult) {
  if (!batchResult || typeof batchResult !== 'object') return String(batchResult ?? '');
  const results = Array.isArray(batchResult.results) ? batchResult.results : [];
  const okCount = results.filter((r) => r.ok).length;
  const headerIcon = batchResult.ok ? '✓' : '✗';
  const abortNote = batchResult.abortedAt !== undefined ? ` (bailed at step ${batchResult.abortedAt})` : '';
  const lines = [`${headerIcon} batch ${okCount}/${results.length} steps ok${abortNote}`];

  const inlineBlocks = [];
  for (const r of results) {
    if (r.ok) {
      let summary = 'ok';
      if (typeof r.result === 'string' && r.result.includes('\n')) {
        summary = `output (${r.result.length} chars, see below)`;
        inlineBlocks.push(`--- step ${r.step} (${r.cmd}) ---\n${r.result}`);
      } else if (r.result && typeof r.result === 'object' && typeof r.result.text === 'string' && r.cmd === 'read') {
        summary = `read (${r.result.text.length} chars, see below)`;
        inlineBlocks.push(`--- step ${r.step} (read ${r.result.url ?? ''}) ---\n${r.result.text}`);
      } else if (r.result && typeof r.result === 'object' && typeof r.result.url === 'string' && r.cmd === 'goto') {
        summary = r.result.url;
      } else if (typeof r.result === 'string' || typeof r.result === 'number' || typeof r.result === 'boolean') {
        summary = quoteShort(r.result, 80);
      }
      lines.push(`  ${r.step}. ${r.cmd} -> ${summary}`);
    } else {
      const code = r.error?.code ?? 'ERROR';
      const msg = r.error?.message ?? 'failed';
      lines.push(`  ${r.step}. ${r.cmd} -> ✗ ${code}: ${msg}`);
      const remedy = r.error?.details?.remedy;
      if (remedy) lines.push(`     建议: ${remedy}`);
    }
  }

  const richDelta = batchResult.delta?.actionDelta;
  if (richDelta) {
    lines.push(richDelta.changed ? 'delta:' : 'delta: no change');
    lines.push(...formatDeltaSection(richDelta));
  } else if (batchResult.delta) {
    // 向后兼容旧形状 BatchDeltaReceipt
    const d = batchResult.delta;
    const parts = [];
    if (d.urlChanged) parts.push(`url -> ${d.url}`);
    if (d.titleChanged && d.title) parts.push(`title: ${quoteShort(d.title, 60)}`);
    if (d.interactiveDelta?.summary) parts.push(d.interactiveDelta.summary);
    if (parts.length > 0) lines.push(`delta: ${parts.join(' | ')}`);
    if (Array.isArray(d.networkSummary)) {
      for (const n of d.networkSummary.slice(0, 8)) lines.push(`  net: ${n}`);
    }
    if (Array.isArray(d.interactiveDelta?.added)) {
      for (const a of d.interactiveDelta.added.slice(0, 15)) {
        lines.push(`  + ${a.role} ${quoteShort(a.name, 50)}${a.ref ? ` [ref=${a.ref}]` : ''}`);
      }
    }
    if (Array.isArray(d.events) && d.events.length > 0) {
      for (const ev of d.events.slice(0, 5)) {
        lines.push(`  [event] ${ev.kind}: ${ev.url ?? ev.message ?? JSON.stringify(ev)}`);
      }
    }
  }

  if (inlineBlocks.length > 0) {
    lines.push('', ...inlineBlocks);
  }
  return lines.join('\n');
}
