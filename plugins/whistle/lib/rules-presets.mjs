/**
 * Whistle 规则组、Presets / Profile 编排、Values 数据区与调试意图工具。
 */
import {
  appendStaticOnlyLayer,
  composePreset,
  diffRules,
  importRulesText,
  mergePresets,
  normalizeText,
  resolvePresetVariables,
  SCENARIOS,
  scenarioLayers,
  scenarioPresetIds,
  sha256,
  validatePreset,
  validateRulesText,
} from '../presets.mjs';
import {
  buildFaultRuleLine,
  buildMapLocalRuleLine,
  buildQuickMockPlan,
  CONTROLLED_GROUPS,
  matchRulesForUrl,
  MOCK_VALUE_PREFIX,
  upsertManagedRuleLine,
} from '../intents.mjs';
import { RULE_NAME, envBoundTo, fail, notifyChanged, requireInstance, withSqlTx } from './shared.mjs';
import {
  call,
  callJson,
  enableMultipleChoice,
  isGroupRuleName,
  postForm,
  readRule,
  readRules,
  readRulesView,
  requireRunningInstance,
  statusOf,
} from './w2-client.mjs';

/** 规则文本 → 模板。用户场景就是「线上地址 + 本地端口」。 */
export function ruleLine(hostPattern, targetPort) {
  return `${hostPattern} 127.0.0.1:${targetPort}`;
}

export async function upsertRule(port, name, rules) {
  const result = await postForm(port, '/cgi-bin/rules/project', { name, rules, groupName: '' });
  if (result.ec !== 0) fail('WHISTLE_RULE_WRITE_FAILED', `写规则失败: ${JSON.stringify(result)}`);
}

export async function setRule(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  await enableMultipleChoice(instance.port);
  const rules = String((input && input.rules) || '');
  const name = String((input && input.name) || RULE_NAME);
  const expectedHash = typeof (input && input.expectedHash) === 'string' ? input.expectedHash : undefined;
  const previous = await readRule(instance.port, name);
  if (expectedHash && sha256(normalizeText(previous?.data ?? '')) !== expectedHash) {
    fail('RULE_STALE', `规则 ${name} 已经变了，请重新读取后再保存`);
  }
  const validation = validateRulesText(rules);
  if (!validation.ok && !(input && input.allowErrors === true)) {
    fail('RULE_INVALID', validation.errors.map((item) => item.message).join('; '));
  }
  await upsertRule(instance.port, name, rules);
  const written = await readRule(instance.port, name);
  const expected = sha256(normalizeText(rules));
  if (!written || sha256(normalizeText(written.data)) !== expected) {
    if (previous) await upsertRule(instance.port, name, previous.data);
    fail('RULE_WRITE_MISMATCH', `写入 ${name} 后读回的内容与目标不一致，已回滚`);
  }
  /*
   * `rules/project` 只保证正文写进去，不保证这一组被选中；Whistle 真正的生效条件是
   * `selected=true`。不补这一步会静默失败：保存成功、回读正文正确，但请求仍按真实网络走。
   */
  if (!written.selected) {
    const enabled = await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
    if (enabled.ec !== 0) {
      if (previous) await upsertRule(instance.port, name, previous.data);
      fail('RULE_ENABLE_FAILED', `规则 ${name} 写入后启用失败：${JSON.stringify(enabled)}`);
    }
  }
  const activated = await readRule(instance.port, name);
  if (!activated || sha256(normalizeText(activated.data)) !== expected || !activated.selected) {
    if (previous) await upsertRule(instance.port, name, previous.data);
    fail('RULE_ENABLE_UNCONFIRMED', `规则 ${name} 启用后回读失败（selected=${Boolean(activated?.selected)}）`);
  }
  await notifyChanged(host, 'ruleSet', { storage: instance.storage, name });
  // 规则的事实来源是 whistle 自己（`rules/list`），插件不另存一份
  return {
    ...(await readRulesView(instance.port)),
    verified: true,
    storage: instance.storage,
    port: instance.port,
    hash: expected,
    selected: true,
    warnings: validation.warnings,
  };
}

export async function toggleRule(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const status = await statusOf(instance.port);
  if (!status) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑，先把它起起来`);
  if (status.storage && status.storage !== instance.storage) {
    fail('WHISTLE_INSTANCE_MISMATCH', `端口 ${instance.port} 当前运行的是 ${status.storage}，不是 ${instance.storage}`);
  }
  const name = String((input && input.name) || RULE_NAME);
  const enabled = Boolean(input && input.enabled);
  if (enabled) await enableMultipleChoice(instance.port);
  const before = await readRule(instance.port, name);
  if (!before) fail('RULE_NOT_FOUND', `没有规则组 ${name}`);
  if (enabled) {
    // project + enable=1 只选择，不改正文。裸 select 会把 data 写成空串（实测）。
    const result = await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
    if (result.ec !== 0) fail('WHISTLE_RULE_TOGGLE_FAILED', `启用 ${name} 失败：${JSON.stringify(result)}`);
  } else {
    // unselect 必须同时带当前正文，否则同样会清空（实测）。
    const result = await postForm(instance.port, '/cgi-bin/rules/unselect', { name, value: before.data });
    if (result.ec !== 0) fail('WHISTLE_RULE_TOGGLE_FAILED', `停用 ${name} 失败：${JSON.stringify(result)}`);
  }
  const after = await readRule(instance.port, name);
  if (!after) {
    await upsertRule(instance.port, name, before.data);
    fail('RULE_TOGGLE_MISMATCH', `切换 ${name} 后规则消失，已恢复`);
  }
  const expectedHash = sha256(normalizeText(before.data));
  if (sha256(normalizeText(after.data)) !== expectedHash) {
    await upsertRule(instance.port, name, before.data);
    fail('RULE_TOGGLE_WIPED', `切换 ${name} 后规则正文变化，已恢复`);
  }
  if (Boolean(after.selected) !== enabled) {
    fail('RULE_TOGGLE_UNCONFIRMED', `切换 ${name} 后 selected=${after.selected}，期望 ${enabled}`);
  }
  await notifyChanged(host, 'ruleToggle', { storage: instance.storage, name, enabled });
  return {
    ...(await readRulesView(instance.port)),
    verified: true,
    storage: instance.storage,
    port: instance.port,
    hash: expectedHash,
  };
}

export async function removeRule(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const name = String((input && input.name) || RULE_NAME);
  await postForm(instance.port, '/cgi-bin/rules/remove', { name });
  await notifyChanged(host, 'ruleRemove', { storage: instance.storage, name });
  return { ...(await readRulesView(instance.port)), storage: instance.storage, port: instance.port };
}

// ── 预设与 profile ─────────────────────────────────────────────────────────

export async function ensurePresetSchema(host) {
  await host.storage.sql.migrate([
    `CREATE TABLE IF NOT EXISTS whistle_presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      current_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whistle_preset_revisions (
      preset_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      definition_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (preset_id, revision)
    );
    CREATE TABLE IF NOT EXISTS whistle_profiles (
      instance_storage TEXT PRIMARY KEY,
      preset_id TEXT,
      revision INTEGER,
      variables_json TEXT NOT NULL DEFAULT '{}',
      layers_json TEXT NOT NULL DEFAULT '{}',
      override_rules TEXT NOT NULL DEFAULT '',
      applied_hash TEXT,
      applied_rules TEXT,
      applied_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whistle_profile_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_storage TEXT NOT NULL,
      event TEXT NOT NULL,
      preset_id TEXT,
      revision INTEGER,
      hash TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );`,
  ]);
}

export async function listPresets(host) {
  return host.storage.sql.query(
    'SELECT id, name, category, description, builtin, current_revision AS revision, updated_at AS updatedAt FROM whistle_presets ORDER BY category, name',
  );
}

export async function getPreset(host, input) {
  const id = String((input && input.id) || (input && input.presetId) || '').trim();
  if (!id) fail('BAD_REQUEST', 'presetGet 需要 id');
  const requested = Number(input && input.revision);
  const rows =
    Number.isInteger(requested) && requested > 0
      ? await host.storage.sql.query(
          'SELECT preset_id AS id, revision, definition_json AS definitionJson, definition_hash AS hash, created_at AS createdAt FROM whistle_preset_revisions WHERE preset_id = ? AND revision = ?',
          [id, requested],
        )
      : await host.storage.sql.query(
          'SELECT r.preset_id AS id, r.revision, r.definition_json AS definitionJson, r.definition_hash AS hash, r.created_at AS createdAt FROM whistle_preset_revisions r JOIN whistle_presets p ON p.id = r.preset_id AND p.current_revision = r.revision WHERE r.preset_id = ?',
          [id],
        );
  const row = rows[0];
  if (!row) fail('PRESET_NOT_FOUND', `没有预设 ${id}${Number.isInteger(requested) ? ` revision ${requested}` : ''}`);
  return { ...row, definition: JSON.parse(String(row.definitionJson)) };
}

/**
 * `local-static-only` 层是 opt-in：只在调用方显式给 `staticOnly` 时加进预设。
 * 默认关闭，避免改变已有预设的行为（计划 §4 风险表）。
 */
export function withStaticOnly(definition, input) {
  const options = input && input.staticOnly;
  if (!options || typeof options !== 'object') return definition;
  return appendStaticOnlyLayer(definition, options);
}

export async function presetDefinitions(host, input, presetIds) {
  if (!presetIds) return [withStaticOnly((await getPreset(host, input)).definition, input)];
  return Promise.all(
    presetIds.map(async (id) => withStaticOnly((await getPreset(host, { ...input, id })).definition, input)),
  );
}

export async function previewPreset(host, input) {
  const layers = resolveScenarioLayers(input);
  const presetIds = resolvePresetIds(input);
  const preset = presetIds ? null : await getPreset(host, input);
  const definitions = await presetDefinitions(host, input, presetIds);
  const resolvedVariables = resolvePresetVariables(definitions, {
    ...input,
    ...(await presetLocalUrl(host, input)),
  });
  if (presetIds) {
    const merged = mergePresets(definitions, { id: input.id, name: input.name });
    const composed = composePreset(merged, {
      variables: resolvedVariables,
      layers,
      conflictPolicy: resolveConflictPolicy(input),
    });
    return { presetIds, mergedId: merged.id, scenario: input?.scenario, ...composed };
  }
  const composed = composePreset(definitions[0], {
    variables: resolvedVariables,
    layers,
    conflictPolicy: resolveConflictPolicy(input),
  });
  return { presetId: preset.id, revision: preset.revision, scenario: input?.scenario, ...composed };
}

export function resolvePresetIds(input) {
  if (Array.isArray(input && input.presetIds)) return input.presetIds;
  if (input && input.scenario && Array.isArray(SCENARIOS[input.scenario]?.presetIds)) {
    return scenarioPresetIds(input.scenario);
  }
  return null;
}

export async function presetLocalUrl(host, input) {
  const explicit = typeof input?.localUrl === 'string' ? input.localUrl.trim() : '';
  if (explicit) return { localUrl: explicit };
  if (!input?.storage) return {};
  try {
    const instance = await requireInstance(host, input.storage);
    const environments = await host.environment.list();
    const bound = envBoundTo(environments, instance.port);
    const url = bound?.currentUrl || '';
    return url ? { localUrl: url } : {};
  } catch {
    return {};
  }
}

export function resolveScenarioLayers(input) {
  const scenario = input && typeof input.scenario === 'string' ? input.scenario : '';
  if (!scenario) return (input && input.layers) || {};
  if (!SCENARIOS[scenario]) fail('BAD_REQUEST', `未知场景 ${scenario}`);
  return { ...scenarioLayers(scenario), ...(input && input.layers) };
}

export function resolveConflictPolicy(input) {
  return input && (input.scenario || Array.isArray(input.presetIds)) ? 'prefer-later' : undefined;
}

export function assertPresetWarnings(composed, input) {
  if (composed.errors.length) fail('PRESET_INVALID', composed.errors.map((item) => item.message).join('; '));
  if (composed.warnings.length && !(input && input.allowWarnings === true)) {
    fail('PRESET_WARNINGS', composed.warnings.map((item) => item.message).join('; '));
  }
}

export async function applyPreset(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  if (!(await statusOf(instance.port))) fail('WHISTLE_INSTANCE_DOWN', `实例 ${instance.storage} 没在跑`);
  await enableMultipleChoice(instance.port);
  const presetIds = resolvePresetIds(input);
  const definitions = await presetDefinitions(host, input, presetIds);
  const preset = presetIds
    ? {
        id: String((input && input.id) || presetIds.join('+')),
        revision: Number((input && input.revision) || 1),
        definition: mergePresets(definitions, { id: input.id, name: input.name }),
      }
    : {
        id: input?.id,
        revision: Number(input?.revision || 1),
        definition: definitions[0],
      };
  const resolvedVariables = resolvePresetVariables(definitions, {
    ...input,
    ...(await presetLocalUrl(host, input)),
  });
  const composed = composePreset(preset.definition, {
    variables: resolvedVariables,
    layers: resolveScenarioLayers(input),
    conflictPolicy: resolveConflictPolicy(input),
  });
  assertPresetWarnings(composed, input);
  const expectedHash = typeof (input && input.expectedHash) === 'string' ? input.expectedHash : composed.hash;
  if (expectedHash !== composed.hash) {
    fail('PRESET_STALE_PREVIEW', `预览已过期：期望 ${expectedHash.slice(0, 12)}，当前 ${composed.hash.slice(0, 12)}`);
  }
  const name = String((input && input.name) || RULE_NAME);
  const previous = await readRule(instance.port, name);
  const previousData = normalizeText(previous?.data ?? '');
  const previousSelected = Boolean(previous?.selected);
  const startedAt = new Date().toISOString();
  await host.storage.sql.run(
    'INSERT INTO whistle_profile_history (instance_storage, event, preset_id, revision, hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      instance.storage,
      'apply.start',
      preset.id,
      preset.revision,
      composed.hash,
      JSON.stringify({ previousHash: sha256(previousData), previousSelected }),
      startedAt,
    ],
  );
  try {
    await upsertRule(instance.port, name, composed.rules);
    let written = await readRule(instance.port, name);
    if (!written || sha256(normalizeText(written.data)) !== composed.hash) {
      throw Object.assign(new Error('写入后读回的规则 hash 不一致'), { code: 'PRESET_WRITE_MISMATCH' });
    }
    if (!written.selected) {
      const enabled = await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
      if (enabled.ec !== 0) {
        throw Object.assign(new Error(`规则写入但启用失败：${JSON.stringify(enabled)}`), {
          code: 'PRESET_ENABLE_FAILED',
        });
      }
      written = await readRule(instance.port, name);
    }
    if (!written || sha256(normalizeText(written.data)) !== composed.hash || !written.selected) {
      throw Object.assign(new Error('启用后复核失败'), { code: 'PRESET_VERIFY_FAILED' });
    }
    const now = new Date().toISOString();
    await host.storage.sql.run(
      `INSERT INTO whistle_profiles (instance_storage, preset_id, revision, variables_json, layers_json, override_rules, applied_hash, applied_rules, applied_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)
       ON CONFLICT(instance_storage) DO UPDATE SET preset_id = excluded.preset_id, revision = excluded.revision,
         variables_json = excluded.variables_json, layers_json = excluded.layers_json,
         applied_hash = excluded.applied_hash, applied_rules = excluded.applied_rules,
         applied_at = excluded.applied_at, updated_at = excluded.updated_at`,
      [
        instance.storage,
        preset.id,
        preset.revision,
        JSON.stringify(resolvedVariables),
        JSON.stringify(resolveScenarioLayers(input)),
        composed.hash,
        composed.rules,
        now,
        now,
      ],
    );
    await host.storage.sql.run(
      'INSERT INTO whistle_profile_history (instance_storage, event, preset_id, revision, hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [instance.storage, 'apply.ok', preset.id, preset.revision, composed.hash, '{}', now],
    );
    await notifyChanged(host, 'presetApply', {
      storage: instance.storage,
      presetId: preset.id,
      revision: preset.revision,
    });
    return {
      storage: instance.storage,
      presetId: preset.id,
      revision: preset.revision,
      scenario: input?.scenario,
      hash: composed.hash,
      selected: true,
      lineCount: composed.lineCount,
      warnings: composed.warnings,
      rules: await readRules(instance.port),
    };
  } catch (error) {
    let rollbackError;
    try {
      await upsertRule(instance.port, name, previousData);
      if (previousSelected) await postForm(instance.port, '/cgi-bin/rules/project', { name, enable: '1' });
      const restored = await readRule(instance.port, name);
      const restoredOk = Boolean(restored) && sha256(normalizeText(restored.data)) === sha256(previousData);
      await host.storage.sql.run(
        'INSERT INTO whistle_profile_history (instance_storage, event, preset_id, revision, hash, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          instance.storage,
          'apply.rollback',
          preset.id,
          preset.revision,
          composed.hash,
          JSON.stringify({ error: error.message, restored: restoredOk }),
          new Date().toISOString(),
        ],
      );
      if (!restoredOk) rollbackError = '旧规则恢复后复核失败';
    } catch (cause) {
      rollbackError = cause.message;
    }
    fail(
      'PRESET_ROLLBACK_FAILED',
      `${error.message}；${rollbackError ? `恢复失败：${rollbackError}` : '已恢复旧规则'}`,
    );
  }
}

export async function getProfile(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const rows = await host.storage.sql.query(
    'SELECT instance_storage AS storage, preset_id AS presetId, revision, variables_json AS variablesJson, layers_json AS layersJson, override_rules AS overrideRules, applied_hash AS appliedHash, applied_at AS appliedAt, updated_at AS updatedAt FROM whistle_profiles WHERE instance_storage = ?',
    [instance.storage],
  );
  if (!rows.length) return { storage: instance.storage, profile: null };
  const row = rows[0];
  return {
    storage: instance.storage,
    profile: {
      ...row,
      variables: JSON.parse(String(row.variablesJson || '{}')),
      layers: JSON.parse(String(row.layersJson || '{}')),
    },
  };
}

export async function clearProfile(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  await host.storage.sql.run('DELETE FROM whistle_profiles WHERE instance_storage = ?', [instance.storage]);
  await notifyChanged(host, 'profileClear', { storage: instance.storage });
  return { storage: instance.storage, cleared: true };
}

export async function savePreset(host, input) {
  const definition = input && input.definition;
  const validation = validatePreset(definition);
  if (!validation.ok) fail('PRESET_INVALID', validation.errors.map((item) => item.message).join('; '));
  const now = new Date().toISOString();
  const normalized = JSON.stringify(definition);
  const hash = sha256(normalized);
  const revision = await withSqlTx(host, async () => {
    const existing = await host.storage.sql.query('SELECT current_revision FROM whistle_presets WHERE id = ?', [
      definition.id,
    ]);
    const nextRevision = existing.length ? Number(existing[0].current_revision) + 1 : 1;
    if (existing.length) {
      await host.storage.sql.run(
        'UPDATE whistle_presets SET name = ?, category = ?, description = ?, current_revision = ?, updated_at = ? WHERE id = ?',
        [definition.name, definition.category ?? '', definition.description ?? '', nextRevision, now, definition.id],
      );
    } else {
      await host.storage.sql.run(
        'INSERT INTO whistle_presets (id, name, category, description, builtin, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        [
          definition.id,
          definition.name,
          definition.category ?? '',
          definition.description ?? '',
          nextRevision,
          now,
          now,
        ],
      );
    }
    await host.storage.sql.run(
      'INSERT INTO whistle_preset_revisions (preset_id, revision, definition_json, definition_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [definition.id, nextRevision, normalized, hash, now],
    );
    return nextRevision;
  });
  await notifyChanged(host, 'presetSave', { presetId: definition.id, revision });
  return { presetId: definition.id, revision, hash };
}

export async function deletePreset(host, input) {
  const id = String((input && input.id) || '').trim();
  if (!id) fail('BAD_REQUEST', 'presetDelete 需要 id');
  await withSqlTx(host, async () => {
    const rows = await host.storage.sql.query('SELECT id FROM whistle_presets WHERE id = ?', [id]);
    if (!rows.length) fail('PRESET_NOT_FOUND', `没有预设 ${id}`);
    await host.storage.sql.run('DELETE FROM whistle_preset_revisions WHERE preset_id = ?', [id]);
    await host.storage.sql.run('DELETE FROM whistle_presets WHERE id = ?', [id]);
  });
  await notifyChanged(host, 'presetDelete', { presetId: id });
  return { presetId: id, deleted: true };
}

export async function importPreset(host, input) {
  const text = String((input && input.text) || '');
  if (!text.trim() && !(input && input.storage && input.name)) fail('BAD_REQUEST', 'presetImport 需要 text');
  let importedText = text;
  if (input && input.storage && input.name && !text.trim()) {
    const instance = await requireInstance(host, input.storage);
    const current = await readRule(instance.port, String(input.name));
    if (!current) fail('RULE_NOT_FOUND', `没有规则组 ${input.name}`);
    importedText = current.data;
  }
  const imported = importRulesText(importedText, {
    id: input && input.id,
    name: (input && input.title) || (input && input.name),
    category: input && input.category,
    description: input && input.description,
  });
  await notifyChanged(host, 'presetImport', { id: imported.draft?.id });
  return imported;
}

export async function exportPreset(host, input) {
  const preset = await getPreset(host, input);
  return { presetId: preset.id, revision: preset.revision, hash: preset.hash, definition: preset.definition };
}

export async function ruleValidate(_host, input) {
  return validateRulesText(String((input && input.rules) || ''));
}

export async function ruleDiff(host, input) {
  const instance = await requireInstance(host, input && input.storage);
  const name = String((input && input.name) || RULE_NAME);
  const current = await readRule(instance.port, name);
  return diffRules(current?.data ?? '', String((input && input.rules) || ''));
}

export async function writeValueRaw(port, name, value) {
  const result = await callJson(port, '/cgi-bin/values/add', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
  if (result.ec !== 0) fail('WHISTLE_VALUE_WRITE_FAILED', `写 Value ${name} 失败：${JSON.stringify(result)}`);
}

export async function valueList(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const res = await call(instance.port, '/cgi-bin/values/list');
  if (!res.ok) fail('WHISTLE_HTTP_ERROR', `/cgi-bin/values/list HTTP ${res.status}`);
  const data = await res.json();
  const query = String((input && input.query) || '')
    .trim()
    .toLowerCase();
  const includeValues = input?.includeValues === true;
  const list = (Array.isArray(data.list) ? data.list : [])
    .filter((item) => item && typeof item.name === 'string' && !isGroupRuleName(item.name))
    .filter((item) => !query || item.name.toLowerCase().includes(query))
    .map((item) => {
      const text = String(item.data ?? '');
      return {
        name: item.name,
        size: Buffer.byteLength(text, 'utf8'),
        ...(includeValues ? { value: text } : { preview: text.slice(0, 120) }),
      };
    });
  return {
    storage: instance.storage,
    port: instance.port,
    total: list.length,
    includeValues,
    values: list,
  };
}

export async function valueGet(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const name = String((input && input.name) || '').trim();
  if (!name) fail('BAD_REQUEST', 'valueGet 需要 name');
  const res = await call(instance.port, `/cgi-bin/values/value?key=${encodeURIComponent(name)}`);
  if (!res.ok) fail('WHISTLE_HTTP_ERROR', `/cgi-bin/values/value HTTP ${res.status}`);
  const data = await res.json();
  if (data.value === undefined) fail('VALUE_NOT_FOUND', `没有 Value ${name}`);
  return {
    storage: instance.storage,
    port: instance.port,
    name,
    value: String(data.value),
  };
}

export async function valueSet(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const name = String((input && input.name) || '').trim();
  if (!name) fail('BAD_REQUEST', 'valueSet 需要 name');
  if (input?.value === undefined) fail('BAD_REQUEST', 'valueSet 需要 value');
  const text =
    typeof input.value === 'object' && input.value !== null
      ? JSON.stringify(input.value, null, 2)
      : String(input.value);
  await writeValueRaw(instance.port, name, text);
  const verifyRes = await call(instance.port, `/cgi-bin/values/value?key=${encodeURIComponent(name)}`);
  const verified = verifyRes.ok ? await verifyRes.json() : {};
  if (verified.value === undefined || sha256(normalizeText(verified.value)) !== sha256(normalizeText(text))) {
    fail('WHISTLE_VALUE_WRITE_MISMATCH', `写入 Value ${name} 后回读不一致`);
  }
  await notifyChanged(host, 'valueSet', { storage: instance.storage, name });
  return {
    storage: instance.storage,
    port: instance.port,
    name,
    size: Buffer.byteLength(text, 'utf8'),
    verified: true,
  };
}

export async function valueRemove(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const names = Array.isArray(input?.names) ? input.names.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const name = String((input && input.name) || '').trim();
  if (!name && !names.length) fail('BAD_REQUEST', 'valueRemove 需要 name 或 names');
  const payload = names.length ? { list: names } : { name };
  const result = await callJson(instance.port, '/cgi-bin/values/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (result.ec !== 0) fail('WHISTLE_VALUE_REMOVE_FAILED', `删除 Value 失败：${JSON.stringify(result)}`);
  await notifyChanged(host, 'valueRemove', { storage: instance.storage, name: name || names[0] });
  return {
    storage: instance.storage,
    port: instance.port,
    ...(names.length ? { names } : { name }),
    removed: true,
  };
}

export async function valueRename(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const name = String((input && input.name) || '').trim();
  const newName = String((input && input.newName) || '').trim();
  if (!name || !newName) fail('BAD_REQUEST', 'valueRename 需要 name 与 newName');
  const existing = await call(instance.port, `/cgi-bin/values/value?key=${encodeURIComponent(name)}`);
  const existingData = existing.ok ? await existing.json() : {};
  if (existingData.value === undefined) fail('VALUE_NOT_FOUND', `没有 Value ${name}`);
  const result = await callJson(instance.port, '/cgi-bin/values/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, newName }),
  });
  if (result.ec !== 0) fail('WHISTLE_VALUE_RENAME_FAILED', `重命名 Value 失败：${JSON.stringify(result)}`);
  await notifyChanged(host, 'valueRename', { storage: instance.storage, name, newName });
  return {
    storage: instance.storage,
    port: instance.port,
    name,
    newName,
    renamed: true,
  };
}

export async function clearDnsCache(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  await callJson(instance.port, '/cgi-bin/rules/clear-dns-cache', { method: 'POST' });
  const resetLocal = input?.resetLocalAddress !== false;
  if (resetLocal) {
    await callJson(instance.port, '/cgi-bin/reset-local-address', { method: 'POST' });
  }
  await notifyChanged(host, 'clearDnsCache', { storage: instance.storage });
  return {
    storage: instance.storage,
    port: instance.port,
    cleared: true,
    dnsCacheCleared: true,
    localAddressReset: resetLocal,
  };
}

export async function ruleTest(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const groups = await readRules(instance.port);
  const analysis = matchRulesForUrl(groups, input || {});
  return {
    storage: instance.storage,
    port: instance.port,
    ...analysis,
  };
}

export async function writeAndSelectControlledRule(port, groupName, nextRules) {
  await enableMultipleChoice(port);
  await upsertRule(port, groupName, nextRules);
  const written = await readRule(port, groupName);
  const expected = sha256(normalizeText(nextRules));
  if (!written || sha256(normalizeText(written.data)) !== expected) {
    fail('RULE_WRITE_MISMATCH', `写入受控规则组 ${groupName} 后回读不一致`);
  }
  if (!written.selected) {
    const enabled = await postForm(port, '/cgi-bin/rules/project', { name: groupName, enable: '1' });
    if (enabled.ec !== 0) fail('RULE_ENABLE_FAILED', `启用受控规则组 ${groupName} 失败`);
  }
  const verified = await readRule(port, groupName);
  if (!verified || !verified.selected) fail('RULE_ENABLE_UNCONFIRMED', `受控规则组 ${groupName} 未保持选中态`);
  return verified.data;
}

export async function quickMock(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const plan = buildQuickMockPlan(input);
  await writeValueRaw(instance.port, plan.valueName, plan.valueBody);
  for (const extra of plan.extraValues) {
    await writeValueRaw(instance.port, extra.name, extra.value);
  }
  const prev = await readRule(instance.port, plan.group);
  const nextRules = upsertManagedRuleLine(prev?.data ?? '', plan.pattern, plan.ruleLine, {
    append: input?.append !== false,
  });
  await writeAndSelectControlledRule(instance.port, plan.group, nextRules);
  await notifyChanged(host, 'quickMock', {
    storage: instance.storage,
    group: plan.group,
    valueName: plan.valueName,
  });
  return {
    storage: instance.storage,
    port: instance.port,
    group: plan.group,
    valueName: plan.valueName,
    ruleLine: plan.ruleLine,
    rules: nextRules,
    selected: true,
  };
}

export async function injectFault(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const plan = buildFaultRuleLine(input);
  const prev = await readRule(instance.port, plan.group);
  const nextRules = upsertManagedRuleLine(prev?.data ?? '', plan.pattern, plan.ruleLine, {
    append: input?.append !== false,
  });
  await writeAndSelectControlledRule(instance.port, plan.group, nextRules);
  await notifyChanged(host, 'injectFault', { storage: instance.storage, group: plan.group });
  return {
    storage: instance.storage,
    port: instance.port,
    group: plan.group,
    ruleLine: plan.ruleLine,
    rules: nextRules,
    selected: true,
  };
}

export async function mapLocal(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const plan = buildMapLocalRuleLine(input);
  const prev = await readRule(instance.port, plan.group);
  const nextRules = upsertManagedRuleLine(prev?.data ?? '', plan.pattern, plan.ruleLine, {
    append: input?.append !== false,
  });
  await writeAndSelectControlledRule(instance.port, plan.group, nextRules);
  await notifyChanged(host, 'mapLocal', { storage: instance.storage, group: plan.group });
  return {
    storage: instance.storage,
    port: instance.port,
    group: plan.group,
    ruleLine: plan.ruleLine,
    rules: nextRules,
    selected: true,
  };
}

export async function clearIntents(host, input) {
  const { instance } = await requireRunningInstance(host, input);
  const requested = Array.isArray(input?.groups) && input.groups.length ? input.groups : ['mock', 'fault', 'local'];
  const targetGroups = [];
  for (const key of requested) {
    const groupName = CONTROLLED_GROUPS[String(key)];
    if (!groupName) fail('BAD_REQUEST', `clearIntents 只允许 mock / fault / local，收到 ${key}`);
    if (!targetGroups.includes(groupName)) targetGroups.push(groupName);
  }
  const existing = await readRules(instance.port);
  const clearedGroups = [];
  for (const groupName of targetGroups) {
    const found = existing.find((item) => item.name === groupName);
    if (!found) continue;
    if (found.selected) {
      await postForm(instance.port, '/cgi-bin/rules/unselect', { name: groupName, value: '' });
    }
    await upsertRule(instance.port, groupName, '');
    clearedGroups.push(groupName);
  }
  const removedValues = [];
  if (input?.removeValues === true) {
    const res = await call(instance.port, '/cgi-bin/values/list');
    if (res.ok) {
      const data = await res.json();
      const names = (Array.isArray(data.list) ? data.list : [])
        .map((item) => String(item?.name || ''))
        .filter((name) => name.startsWith(MOCK_VALUE_PREFIX));
      if (names.length) {
        await callJson(instance.port, '/cgi-bin/values/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ list: names }),
        });
        removedValues.push(...names);
      }
    }
  }
  await notifyChanged(host, 'clearIntents', { storage: instance.storage, groups: clearedGroups });
  return {
    storage: instance.storage,
    port: instance.port,
    clearedGroups,
    removedValues,
  };
}
