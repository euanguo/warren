/**
 * Whistle 代理插件前端。
 *
 * 没有构建步骤：普通 ESM，由主进程经 `warren-plugin://com.warren.whistle/app.js` 供给。
 * React **和组件库**都由宿主注入（`app.React` / `app.h` / `app.ui`）——不要自带 React，
 * 也不要手写 `<div className="rounded-md border">`：那等于自己抄一遍设计契约。
 * 清单见 `plugins/README.md`。
 *
 * 抓包界面**不嵌 iframe**（要放宽 CSP，而且那是另一套视觉），用「打开面板」按钮
 * 在**这个环境自己的标签里**打开（`host.browser.openTab`），不甩到系统浏览器。
 */
export default function register(app) {
  const { h, React, ui } = app;
  const { useCallback, useEffect, useState } = React;
  const {
    Button,
    Input,
    Textarea,
    Switch,
    Badge,
    Field,
    FieldLabel,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Empty,
    EmptyContent,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    EmptyDescription,
    Icon,
    cn,
    toast,
    cardSurfaceClass,
  } = ui;

  function useInstances() {
    const [data, setData] = useState({ instances: [], environments: [], w2: '' });
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
      app.rpc
        .call('list')
        .then((next) => {
          setData(next);
          setError(null);
        })
        .catch((err) => setError(String(err.message || err)));
    }, []);

    useEffect(() => {
      load();
    }, [load]);

    /** 所有写操作都走这里：成功后用返回值刷新，失败弹 toast（宿主自己的报错方式）。 */
    const run = useCallback(async (work, failure) => {
      setBusy(true);
      try {
        const result = await work();
        if (result && Array.isArray(result.instances)) setData(result);
        setError(null);
        return result;
      } catch (err) {
        toast.error(failure, { description: String(err.message || err) });
        return null;
      } finally {
        setBusy(false);
      }
    }, []);

    return { ...data, error, busy, load, run };
  }

  function NewInstanceDialog({ environments, busy, run, onCreated }) {
    const [open, setOpen] = useState(false);
    const [storage, setStorage] = useState('');
    const [hostPattern, setHostPattern] = useState('');
    const [targetPort, setTargetPort] = useState('');
    const [bindTo, setBindTo] = useState('');

    const create = async () => {
      const result = await run(
        () =>
          app.rpc.call('fork', {
            storage: storage.trim(),
            hostPattern: hostPattern.trim(),
            targetPort: Number(targetPort) || 0,
          }),
        '新建实例失败',
      );
      if (!result) return;
      const created = result.created;
      // 顺手绑定：用户场景就是「起一个实例，给这个 worktree 用」
      if (bindTo) {
        await run(() => app.rpc.call('bind', { storage: created.storage, environmentId: bindTo }), '绑定环境失败');
      }
      setOpen(false);
      setStorage('');
      setHostPattern('');
      setTargetPort('');
      setBindTo('');
      onCreated?.(created);
    };

    return h(
      React.Fragment,
      null,
      h(Button, { onClick: () => setOpen(true) }, h(Icon, { name: 'Plus' }), '新建实例'),
      h(
        Dialog,
        { open, onOpenChange: setOpen },
        h(
          DialogContent,
          null,
          // data-slot 套在内层：别盖掉组件自己的 data-slot（验收选择器靠它）
          h(
            'div',
            { 'data-slot': 'whistle-new', className: 'flex flex-col gap-4' },
            h(
              DialogHeader,
              null,
              h(DialogTitle, null, '新建代理实例'),
              h(
                DialogDescription,
                null,
                '一个实例 = 一个独立 whistle 进程：自己的端口、自己的规则文件、自己的抓包记录。',
              ),
            ),
            h(
              'div',
              { className: 'flex flex-col gap-4' },
              h(
                Field,
                null,
                h(FieldLabel, { htmlFor: 'whistle-storage' }, '实例名'),
                h(Input, {
                  id: 'whistle-storage',
                  value: storage,
                  onChange: (event) => setStorage(event.target.value),
                  placeholder: '例如 dev-a（留空自动起名）',
                }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, { htmlFor: 'whistle-host' }, '线上地址'),
                h(Input, {
                  id: 'whistle-host',
                  value: hostPattern,
                  onChange: (event) => setHostPattern(event.target.value),
                  placeholder: '例如 app.example.com/static/',
                }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, { htmlFor: 'whistle-port' }, '本地端口'),
                h(Input, {
                  id: 'whistle-port',
                  value: targetPort,
                  onChange: (event) => setTargetPort(event.target.value),
                  placeholder: '例如 5199（留空自动挑一个）',
                }),
              ),
              h(
                Field,
                null,
                h(FieldLabel, null, '绑定到环境'),
                h(
                  Select,
                  { value: bindTo, onValueChange: (value) => setBindTo(value) },
                  h(
                    SelectTrigger,
                    null,
                    h(SelectValue, { placeholder: '先不绑定' }, (value) =>
                      value ? (environments.find((env) => env.id === value)?.name ?? String(value)) : '先不绑定',
                    ),
                  ),
                  h(
                    SelectContent,
                    null,
                    h(SelectItem, { value: '' }, '先不绑定'),
                    ...environments.map((env) => h(SelectItem, { key: env.id, value: env.id }, env.name)),
                  ),
                ),
              ),
              h(
                'p',
                { className: 'text-xs text-muted-foreground' },
                '端口留空会自动挑一个；填了线上地址与本地端口就会写成「线上地址 → 127.0.0.1:本地端口」的规则，HTTPS 解密一并打开。',
              ),
            ),
            h(
              DialogFooter,
              null,
              h(Button, { variant: 'ghost', onClick: () => setOpen(false) }, '取消'),
              h(Button, { disabled: busy, onClick: create }, '创建'),
            ),
          ),
        ),
      ),
    );
  }

  function RuleEditor({ instance, presets, run }) {
    const [rules, setRules] = useState(null);
    const [draft, setDraft] = useState({});
    const [error, setError] = useState(null);

    const load = useCallback(() => {
      app.rpc
        .call('rules', { storage: instance.storage })
        .then((result) => {
          setRules(result.rules);
          setDraft({});
          setError(null);
        })
        .catch((err) => setError(String(err.message || err)));
    }, [instance.storage]);

    useEffect(() => {
      load();
    }, [load]);

    if (error) return h('p', { className: 'text-xs text-destructive' }, error);
    if (!rules) return h('p', { className: 'text-xs text-muted-foreground' }, '读取规则…');

    const apply = (result) => {
      if (result && Array.isArray(result.rules)) {
        setRules(result.rules);
        setDraft({});
      }
    };

    return h(
      'div',
      { className: 'flex flex-col gap-2', 'data-slot': 'whistle-rules' },
      h(
        'div',
        { className: 'flex items-center gap-2' },
        h('span', { className: 'text-sm font-medium' }, `规则 · ${instance.storage}`),
        h('span', { className: 'text-xs text-muted-foreground' }, `预设 ${presets.length} 个`),
        h(Button, { variant: 'ghost', className: 'ml-auto', onClick: load }, '重新读取'),
      ),
      rules.length === 0 && h('p', { className: 'text-xs text-muted-foreground' }, '这个实例还没有规则。'),
      ...rules.map((rule) =>
        h(
          'div',
          { key: rule.name, className: cn(cardSurfaceClass, 'flex flex-col gap-2') },
          h(
            'div',
            { className: 'flex items-center gap-2' },
            h('span', { className: 'text-xs font-medium' }, rule.name),
            h(
              ui.Field,
              { orientation: 'horizontal', className: 'ml-auto' },
              h(Switch, {
                id: `rule-${rule.name}`,
                checked: Boolean(rule.selected),
                onCheckedChange: (checked) =>
                  run(
                    () =>
                      app.rpc.call('ruleToggle', {
                        storage: instance.storage,
                        name: rule.name,
                        enabled: checked,
                      }),
                    '开关规则失败',
                  ).then(apply),
              }),
              h(FieldLabel, { htmlFor: `rule-${rule.name}` }, '启用'),
            ),
            h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                onClick: () =>
                  run(
                    () => app.rpc.call('ruleRemove', { storage: instance.storage, name: rule.name }),
                    '删除规则失败',
                  ).then(apply),
              },
              '删除',
            ),
          ),
          h(Textarea, {
            className: 'min-h-16 font-mono',
            value: draft[rule.name] === undefined ? rule.data : draft[rule.name],
            onChange: (event) => setDraft({ ...draft, [rule.name]: event.target.value }),
          }),
          h(
            'div',
            { className: 'flex items-center gap-2' },
            h(
              Button,
              {
                size: 'sm',
                disabled: draft[rule.name] === undefined || draft[rule.name] === rule.data,
                onClick: () =>
                  run(
                    () =>
                      app.rpc.call('ruleSet', {
                        storage: instance.storage,
                        name: rule.name,
                        rules: draft[rule.name],
                      }),
                    '保存规则失败',
                  ).then(apply),
              },
              '保存',
            ),
            h('span', { className: 'text-xs text-muted-foreground' }, '改完保存即可生效，不用重启环境'),
          ),
        ),
      ),
    );
  }

  /** 预设应用：变量、层开关、预览、hash、warning 都在这一个对话框里完成。 */
  function PresetDialog({ instance, presets, busy, onApplied }) {
    const [open, setOpen] = useState(false);
    const [presetId, setPresetId] = useState('');
    const [extraPresetIds, setExtraPresetIds] = useState([]);
    const [extraDefinitions, setExtraDefinitions] = useState({});
    const [loadingExtraId, setLoadingExtraId] = useState(null);
    const [applying, setApplying] = useState(false);
    const [revision, setRevision] = useState(null);
    const [definition, setDefinition] = useState(null);
    const [variables, setVariables] = useState({});
    const [localUrl, setLocalUrl] = useState('');
    const [layers, setLayers] = useState({});
    const [preview, setPreview] = useState(null);
    const [loading, setLoading] = useState(false);

    const selectPreset = async (id) => {
      setPresetId(id);
      setPreview(null);
      setExtraPresetIds([]);
      setExtraDefinitions({});
      if (!id) {
        setDefinition(null);
        return;
      }
      setLoading(true);
      try {
        const preset = await app.rpc.call('presetGet', { id });
        const def = preset.definition;
        setDefinition(def);
        setRevision(preset.revision);
        const nextVars = {};
        for (const [key, descriptor] of Object.entries(def.variables ?? {})) {
          nextVars[key] = descriptor.default ?? '';
        }
        let inferredUrl = '';
        if (instance.environmentId) {
          try {
            const environment = await app.host.environment.get(instance.environmentId);
            const currentUrl = environment?.currentUrl ?? '';
            const parsed = new URL(currentUrl);
            if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && parsed.port) {
              inferredUrl = currentUrl;
              for (const [key, descriptor] of Object.entries(def.variables ?? {})) {
                if (descriptor.type === 'port') nextVars[key] = parsed.port;
              }
            }
          } catch {
            // 环境未运行或地址不是 URL：保留手填变量。
          }
        }
        setLocalUrl(inferredUrl);
        setVariables(nextVars);
        const nextLayers = {};
        for (const layer of def.layers ?? []) nextLayers[layer.id] = layer.enabled !== false;
        setLayers(nextLayers);
      } catch (error) {
        toast.error('读取预设失败', { description: String(error.message || error) });
      } finally {
        setLoading(false);
      }
    };

    const selectPresetIds = presetId ? [presetId, ...extraPresetIds.filter((id) => id !== presetId)] : [];
    const definitions = definition
      ? [definition, ...extraPresetIds.map((id) => extraDefinitions[id]).filter(Boolean)]
      : [];
    const mergedVariables = Object.assign({}, ...definitions.map((item) => item.variables ?? {}));
    const layerEntries = [];
    const seenLayers = new Set();
    for (const item of definitions) {
      for (const layer of item.layers ?? []) {
        if (seenLayers.has(layer.id)) {
          const index = layerEntries.findIndex((entry) => entry.layer.id === layer.id);
          if (index >= 0) layerEntries.splice(index, 1);
        }
        seenLayers.add(layer.id);
        layerEntries.push({ layer, preset: item });
      }
    }

    const syncCombinedFields = (nextDefinitions) => {
      setVariables((current) => {
        const next = { ...current };
        for (const item of nextDefinitions) {
          for (const [key, descriptor] of Object.entries(item.variables ?? {})) {
            if (next[key] === undefined) next[key] = descriptor.default ?? '';
          }
        }
        return next;
      });
      setLayers((current) => {
        const next = { ...current };
        for (const item of nextDefinitions) {
          for (const layer of item.layers ?? []) {
            if (next[layer.id] === undefined) next[layer.id] = layer.enabled !== false;
          }
        }
        return next;
      });
    };

    const toggleExtraPreset = async (id, checked) => {
      setPreview(null);
      if (!checked) {
        setExtraPresetIds((current) => current.filter((item) => item !== id));
        setExtraDefinitions((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        return;
      }
      if (extraDefinitions[id]) {
        setExtraPresetIds((current) => (current.includes(id) ? current : [...current, id]));
        syncCombinedFields([definition, ...Object.values(extraDefinitions)]);
        return;
      }
      setLoadingExtraId(id);
      try {
        const preset = await app.rpc.call('presetGet', { id });
        const nextDefinitions = { ...extraDefinitions, [id]: preset.definition };
        setExtraDefinitions(nextDefinitions);
        setExtraPresetIds((current) => (current.includes(id) ? current : [...current, id]));
        syncCombinedFields([definition, ...Object.values(nextDefinitions)]);
      } catch (error) {
        toast.error('读取叠加预设失败', { description: String(error.message || error) });
      } finally {
        setLoadingExtraId(null);
      }
    };

    const doPreview = async () => {
      setLoading(true);
      try {
        const result = await app.rpc.call('presetPreview', {
          storage: instance.storage,
          ...(extraPresetIds.length ? { presetIds: selectPresetIds } : { id: presetId }),
          variables,
          ...(localUrl.trim() ? { localUrl: localUrl.trim() } : {}),
          layers,
        });
        setPreview(result);
      } catch (error) {
        toast.error('预览失败', { description: String(error.message || error) });
      } finally {
        setLoading(false);
      }
    };

    const doApply = async () => {
      if (!preview) return;
      setApplying(true);
      try {
        const result = await app.rpc.call('presetApply', {
          storage: instance.storage,
          ...(extraPresetIds.length ? { presetIds: selectPresetIds } : { id: presetId }),
          revision,
          variables,
          ...(localUrl.trim() ? { localUrl: localUrl.trim() } : {}),
          layers,
          expectedHash: preview.hash,
          allowWarnings: preview.warnings?.length > 0,
        });
        toast.success('预设已应用', { description: `${result.lineCount} 行 · ${result.hash.slice(0, 12)}` });
        setOpen(false);
        onApplied?.(result);
      } catch (error) {
        toast.error('应用预设失败', { description: String(error.message || error) });
      } finally {
        setApplying(false);
      }
    };

    return h(
      React.Fragment,
      null,
      h(Button, { size: 'sm', onClick: () => setOpen(true) }, '应用预设'),
      h(
        Dialog,
        { open, onOpenChange: setOpen },
        h(
          DialogContent,
          { className: 'max-h-[85vh] overflow-auto' },
          h(
            'div',
            { className: 'flex flex-col gap-4', 'data-slot': 'whistle-preset-dialog' },
            h(
              DialogHeader,
              null,
              h(DialogTitle, null, '应用预设'),
              h(DialogDescription, null, `实例 ${instance.storage}。先预览，再应用；应用失败会自动回滚。`),
            ),
            h(
              Field,
              null,
              h(FieldLabel, null, '预设'),
              h(
                Select,
                { value: presetId, onValueChange: (value) => void selectPreset(value) },
                h(
                  SelectTrigger,
                  null,
                  h(SelectValue, { placeholder: '选择一个预设' }, (value) => {
                    const item = presets.find((preset) => preset.id === value);
                    return item ? `${item.name} · r${item.revision}` : '选择一个预设';
                  }),
                ),
                h(
                  SelectContent,
                  null,
                  ...presets.map((preset) => h(SelectItem, { key: preset.id, value: preset.id }, preset.name)),
                ),
              ),
            ),
            definition
              ? h(
                  'div',
                  { className: 'flex flex-col gap-3' },
                  extraPresetIds.length
                    ? h(
                        'div',
                        { className: 'flex items-center gap-2 text-xs' },
                        h('span', null, `组合：${[presetId, ...extraPresetIds].join(' + ')}`),
                        h(
                          Button,
                          {
                            size: 'sm',
                            variant: 'ghost',
                            onClick: () => {
                              setExtraPresetIds([]);
                              setPreview(null);
                            },
                          },
                          '取消组合',
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'flex flex-col gap-2' },
                    h('span', { className: 'text-xs font-medium' }, '变量'),
                    h(
                      Field,
                      null,
                      h(FieldLabel, { htmlFor: 'preset-local-url' }, '本地服务地址（可选，自动提取端口）'),
                      h(Input, {
                        id: 'preset-local-url',
                        value: localUrl,
                        placeholder: '例如 http://127.0.0.1:你的本地端口',
                        onChange: (event) => {
                          setLocalUrl(event.target.value);
                          setPreview(null);
                        },
                      }),
                    ),
                    ...Object.entries(mergedVariables).map(([key, descriptor]) =>
                      h(
                        Field,
                        { key },
                        h(
                          FieldLabel,
                          { htmlFor: `preset-var-${key}` },
                          `${descriptor.label ?? key}${descriptor.required ? ' *' : ''}`,
                        ),
                        h(Input, {
                          id: `preset-var-${key}`,
                          value: String(variables[key] ?? ''),
                          onChange: (event) => {
                            setVariables({ ...variables, [key]: event.target.value });
                            setPreview(null);
                          },
                        }),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'flex flex-col gap-2' },
                    h('span', { className: 'text-xs font-medium' }, '叠加其他预设'),
                    ...presets
                      .filter((preset) => preset.id !== presetId)
                      .map((preset) =>
                        h(
                          ui.Field,
                          { key: preset.id, orientation: 'horizontal' },
                          h(Switch, {
                            id: `preset-extra-${preset.id}`,
                            checked: extraPresetIds.includes(preset.id),
                            disabled: loadingExtraId === preset.id,
                            onCheckedChange: (checked) => void toggleExtraPreset(preset.id, checked),
                          }),
                          h(FieldLabel, { htmlFor: `preset-extra-${preset.id}` }, preset.name),
                        ),
                      ),
                  ),
                  h(
                    'div',
                    { className: 'flex flex-col gap-2' },
                    h('span', { className: 'text-xs font-medium' }, '层'),
                    ...layerEntries.map(({ layer, preset }) =>
                      h(
                        ui.Field,
                        { key: `${preset.id}-${layer.id}`, orientation: 'horizontal' },
                        h(Switch, {
                          id: `preset-layer-${preset.id}-${layer.id}`,
                          checked: Boolean(layers[layer.id]),
                          onCheckedChange: (checked) => {
                            setLayers({ ...layers, [layer.id]: checked });
                            setPreview(null);
                          },
                        }),
                        h(
                          FieldLabel,
                          { htmlFor: `preset-layer-${preset.id}-${layer.id}` },
                          `${preset.id === definition.id ? '' : `${preset.name} / `}${layer.id} · ${layer.kind}`,
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'flex items-center gap-2' },
                    h(Button, { size: 'sm', variant: 'outline', disabled: loading, onClick: doPreview }, '预览'),
                    h('span', { className: 'text-xs text-muted-foreground' }, '预览是应用前的最后一道校验'),
                  ),
                  preview
                    ? h(
                        'div',
                        {
                          className: 'flex flex-col gap-2 rounded-md border border-border p-3',
                          'data-slot': 'whistle-preset-preview',
                        },
                        h('span', { className: 'text-xs' }, `${preview.lineCount} 行 · ${preview.charCount} 字符`),
                        h('span', { className: 'font-mono text-[10px] text-muted-foreground' }, preview.hash),
                        ...(preview.errors ?? []).map((item, index) =>
                          h('p', { key: `error-${index}`, className: 'text-xs text-destructive' }, item.message),
                        ),
                        ...(preview.warnings ?? []).map((item, index) =>
                          h('p', { key: `warning-${index}`, className: 'text-xs text-[var(--warning)]' }, item.message),
                        ),
                        h(
                          'pre',
                          {
                            className:
                              'max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground',
                          },
                          preview.rules,
                        ),
                      )
                    : null,
                )
              : null,
            h(
              DialogFooter,
              null,
              h(Button, { variant: 'ghost', onClick: () => setOpen(false) }, '取消'),
              h(
                Button,
                {
                  disabled: busy || applying || loading || !preview || (preview.errors?.length ?? 0) > 0,
                  onClick: doApply,
                },
                '应用',
              ),
            ),
          ),
        ),
      ),
    );
  }

  function InstanceRow({ instance, environments, presets, busy, run, selected, onSelect, onPresetSaved }) {
    const [bindTo, setBindTo] = useState(instance.environmentId || '');
    const [profile, setProfile] = useState(null);

    useEffect(() => {
      app.rpc
        .call('profileGet', { storage: instance.storage })
        .then((result) => setProfile(result.profile))
        .catch(() => setProfile(null));
    }, [instance.storage]);
    return h(
      'div',
      {
        className: cn(ui.cardSurfaceClass, 'flex flex-col gap-2', selected && 'ring-1 ring-border-heavy'),
        'data-slot': 'whistle-instance',
        'data-storage': instance.storage,
        'data-alive': String(instance.alive),
      },
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2 text-xs' },
        h('span', { className: 'font-medium' }, instance.storage),
        h('span', { className: 'text-muted-foreground' }, `:${instance.port}`),
        h(Badge, { variant: instance.alive ? 'secondary' : 'outline' }, instance.alive ? '运行中' : '已停止'),
        instance.targetPort
          ? h('span', { className: 'text-muted-foreground' }, `→ 127.0.0.1:${instance.targetPort}`)
          : null,
        instance.environmentName
          ? h('span', { className: 'text-muted-foreground' }, `绑定 ${instance.environmentName}`)
          : null,
        profile
          ? h(
              'span',
              { className: 'text-muted-foreground', 'data-slot': 'whistle-profile-current' },
              `预设 ${profile.presetId} · r${profile.revision} · ${String(profile.appliedHash ?? '').slice(0, 8)}`,
            )
          : null,
        h(
          'div',
          { className: 'ml-auto flex items-center gap-1' },
          h(
            Button,
            {
              size: 'sm',
              // 标签挂在环境上：没绑定就没有地方开，先绑
              disabled: busy || !instance.environmentId,
              title: instance.environmentId ? '' : '先把这个实例绑定到一个环境，才能在该环境的标签里打开',
              onClick: () => run(() => app.rpc.call('open', { environmentId: instance.environmentId }), '打开面板失败'),
            },
            '打开面板',
          ),
          h(Button, { size: 'sm', variant: 'ghost', onClick: onSelect }, selected ? '收起规则' : '规则'),
          h(ImportPresetButton, { instance, onSaved: onPresetSaved }),
          h(PresetDialog, {
            instance,
            presets,
            busy,
            onApplied: () => onSelect?.(),
          }),
          instance.alive
            ? h(
                Button,
                {
                  size: 'sm',
                  variant: 'ghost',
                  disabled: busy,
                  onClick: () => run(() => app.rpc.call('stop', { storage: instance.storage }), '停止实例失败'),
                },
                '停止',
              )
            : null,
          h(
            Button,
            {
              size: 'sm',
              variant: 'ghost',
              disabled: busy,
              onClick: () => run(() => app.rpc.call('remove', { storage: instance.storage }), '删除实例失败'),
            },
            '删除',
          ),
        ),
      ),
      h(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        h(
          Select,
          { value: bindTo, onValueChange: (value) => setBindTo(value) },
          h(
            SelectTrigger,
            { className: 'w-40' },
            h(SelectValue, { placeholder: '不绑定环境' }, (value) =>
              value ? (environments.find((env) => env.id === value)?.name ?? String(value)) : '不绑定环境',
            ),
          ),
          h(
            SelectContent,
            null,
            h(SelectItem, { value: '' }, '不绑定环境'),
            ...environments.map((env) => h(SelectItem, { key: env.id, value: env.id }, env.name)),
          ),
        ),
        h(
          Button,
          {
            size: 'sm',
            disabled: busy || !bindTo || !instance.alive,
            onClick: () =>
              run(() => app.rpc.call('bind', { storage: instance.storage, environmentId: bindTo }), '绑定环境失败'),
          },
          '绑定到环境',
        ),
        instance.environmentId
          ? h(
              Button,
              {
                size: 'sm',
                variant: 'ghost',
                disabled: busy,
                onClick: () => run(() => app.rpc.call('unbind', { environmentId: instance.environmentId }), '解绑失败'),
              },
              '解绑',
            )
          : null,
        h(
          'span',
          { className: 'text-xs text-muted-foreground' },
          '绑定会写环境的代理 + 信任这个实例的根证书；环境在跑就自动重启',
        ),
      ),
    );
  }

  function ImportPresetButton({ instance, onSaved }) {
    const [busy, setBusy] = useState(false);
    const importRule = async () => {
      setBusy(true);
      try {
        const result = await app.rpc.call('presetImport', {
          storage: instance.storage,
          name: 'warren',
          id: `${instance.storage}-imported`,
          title: `${instance.storage} 导入`,
        });
        if (!result.ok) throw new Error(result.errors?.map((item) => item.message).join('; ') || '导入失败');
        const definition = { ...result.draft };
        delete definition.draft;
        const saved = await app.rpc.call('presetSave', { definition });
        await onSaved?.();
        toast.success('导入规则已保存', {
          description: `${result.lineCount} 行，${definition.layers.length} 个层 · ${saved.presetId} r${saved.revision}`,
        });
      } catch (error) {
        toast.error('导入规则失败', { description: String(error.message || error) });
      } finally {
        setBusy(false);
      }
    };
    return h(
      Button,
      { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => void importRule() },
      busy ? '导入中…' : '导入规则',
    );
  }

  function ProxyPage() {
    const { instances, environments, w2, error, busy, load, run } = useInstances();
    const [selected, setSelected] = useState(null);
    const [presets, setPresets] = useState([]);
    const current = instances.find((item) => item.storage === selected);

    const loadPresets = useCallback(() => {
      app.rpc
        .call('presetList')
        .then((result) => setPresets(result.presets ?? []))
        .catch(() => setPresets([]));
    }, []);

    useEffect(() => {
      loadPresets();
    }, [loadPresets]);

    return h(
      'div',
      {
        className: 'flex h-full flex-col gap-4 overflow-auto',
        style: { maxWidth: '1040px', marginInline: 'auto', width: '100%', padding: '20px 24px' },
        'data-slot': 'whistle-page',
      },
      h(
        'div',
        { className: 'flex items-center gap-2.5' },
        h(
          'span',
          {
            'aria-hidden': true,
            style: { '--brand-hue': 192 },
            className: 'plugin-brand-chip flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
          },
          h(Icon, { name: 'Globe', className: 'size-4' }),
        ),
        h('h1', { className: 'text-lg font-semibold text-foreground' }, '代理实例'),
        h(
          'span',
          { className: 'text-xs text-muted-foreground', title: w2 },
          `${instances.filter((item) => item.alive).length}/${instances.length} 在跑 · ${w2.startsWith('bundled:') ? '内置 Whistle' : w2}`,
        ),
        h(
          Button,
          { variant: 'outline', size: 'sm', className: 'ml-auto', onClick: load },
          h(Icon, { name: 'Refresh', className: 'size-3.5' }),
          '刷新',
        ),
        h(NewInstanceDialog, { environments, busy, run, onCreated: () => setSelected(null) }),
      ),
      error && h('p', { className: 'text-xs text-destructive' }, error),
      instances.length === 0
        ? h(
            Empty,
            null,
            h(
              EmptyHeader,
              null,
              h(EmptyMedia, { variant: 'icon' }, h(Icon, { name: 'Globe' })),
              h(EmptyTitle, null, '还没有代理实例'),
              h(EmptyDescription, null, '为环境创建独立的 Whistle 进程、端口与抓包规则。'),
            ),
            h(
              EmptyContent,
              null,
              h(NewInstanceDialog, { environments, busy, run, onCreated: () => setSelected(null) }),
            ),
          )
        : h(
            'div',
            { className: 'flex flex-col gap-2' },
            ...instances.map((instance) =>
              h(InstanceRow, {
                key: instance.storage,
                instance,
                environments,
                presets,
                busy,
                run,
                selected: selected === instance.storage,
                onSelect: () => setSelected(selected === instance.storage ? null : instance.storage),
                onPresetSaved: loadPresets,
              }),
            ),
          ),
      current ? h(RuleEditor, { instance: current, presets, run }) : null,
    );
  }

  function AboutSection() {
    return h(
      'div',
      { className: 'flex flex-col gap-2 text-xs text-muted-foreground' },
      h('p', null, '每个实例是一个独立的 whistle 进程：自己的端口、自己的规则文件、自己的抓包记录。'),
      h(
        'p',
        null,
        '绑定一个环境 = 把它的代理指向实例端口，并让这个环境信任该实例的根证书（只对这一个环境生效，不动系统钥匙串）。',
      ),
      h('p', null, '实例是守护进程：插件禁用或卸载之后，已经在跑的实例不会被停掉。'),
      h('p', null, '注意：同一个环境不要同时开「网络规则」和 whistle 绑定，两边都会拦请求，谁先接管没定义。'),
    );
  }

  function WhistleInspectorTab({ environmentId }) {
    const { instances, busy, load, run } = useInstances();
    const [rulesData, setRulesData] = useState(null);
    const [profile, setProfile] = useState(null);
    const bound = instances.find((item) => item.environmentId === environmentId);

    const loadBoundDetails = useCallback(() => {
      if (!bound || !bound.alive) {
        setRulesData(null);
        setProfile(null);
        return;
      }
      app.rpc
        .call('rules', { storage: bound.storage })
        .then(setRulesData)
        .catch(() => setRulesData(null));
      app.rpc
        .call('profileGet', { storage: bound.storage })
        .then((res) => setProfile(res?.profile ?? null))
        .catch(() => setProfile(null));
    }, [bound]);

    useEffect(() => {
      loadBoundDetails();
    }, [loadBoundDetails]);

    if (!environmentId) {
      return h('p', { className: 'text-xs text-muted-foreground' }, '先选择一个运行中的环境。');
    }

    if (!bound) {
      return h(
        'div',
        { className: 'flex flex-col gap-2.5 text-xs', 'data-slot': 'whistle-inspector' },
        h(
          'div',
          { className: cn(cardSurfaceClass, 'flex flex-col gap-2 py-2.5') },
          h(
            'div',
            { className: 'flex items-center gap-1.5 font-medium text-foreground' },
            h(Icon, { name: 'Globe', className: 'size-3.5 text-muted-foreground' }),
            h('span', null, '当前环境未绑定 Whistle 代理实例'),
          ),
          h(
            'p',
            { className: 'text-[length:var(--font-size-micro)] leading-relaxed text-muted-foreground' },
            instances.length > 0
              ? '从下方快捷绑定已有实例，自动配置代理并信任根证书。'
              : '尚未创建独立 Whistle 实例，新建后即可绑定到此环境。',
          ),
          instances.length === 0
            ? h(
                Button,
                {
                  size: 'sm',
                  className: 'mt-0.5 self-start',
                  'data-slot': 'whistle-open-global-cta',
                  onClick: () => app.navigation?.openPage?.('proxy'),
                },
                h(Icon, { name: 'Plus', className: 'size-3.5' }),
                '前往新建代理实例',
              )
            : null,
        ),
        instances.length > 0
          ? h(
              'div',
              { className: 'flex flex-col gap-1.5' },
              h(
                'div',
                { className: 'flex items-center justify-between gap-2' },
                h(
                  'span',
                  { className: 'text-[length:var(--font-size-micro)] text-muted-foreground' },
                  '快捷绑定已有实例：',
                ),
                h(
                  Button,
                  {
                    size: 'xs',
                    variant: 'ghost',
                    onClick: () => app.navigation?.openPage?.('proxy'),
                  },
                  '管理全部实例',
                ),
              ),
              ...instances.slice(0, 5).map((inst) =>
                h(
                  'div',
                  {
                    key: inst.storage,
                    className: cn(cardSurfaceClass, 'flex items-center justify-between gap-2 py-1.5'),
                  },
                  h('span', { className: 'truncate font-mono' }, `${inst.storage} :${inst.port}`),
                  h(
                    Button,
                    {
                      size: 'xs',
                      variant: 'outline',
                      disabled: busy,
                      onClick: () =>
                        run(() => app.rpc.call('bind', { storage: inst.storage, environmentId }), '绑定实例失败').then(
                          load,
                        ),
                    },
                    '绑定',
                  ),
                ),
              ),
            )
          : null,
      );
    }

    const groups = Array.isArray(rulesData?.groups) ? rulesData.groups : [];
    return h(
      'div',
      { className: 'flex flex-col gap-2.5 text-xs', 'data-slot': 'whistle-inspector' },
      h(
        'div',
        { className: cn(cardSurfaceClass, 'flex flex-col gap-2') },
        h(
          'div',
          { className: 'flex items-center gap-1.5' },
          h('span', { className: 'truncate font-medium' }, bound.storage),
          h('span', { className: 'font-mono text-muted-foreground' }, `:${bound.port}`),
          h(
            Badge,
            { variant: bound.alive ? 'secondary' : 'outline', className: 'ml-auto shrink-0' },
            bound.alive ? '运行中' : '已停止',
          ),
        ),
        profile
          ? h(
              'span',
              { className: 'truncate font-mono text-[11px] text-muted-foreground' },
              `当前预设：${profile.presetId} r${profile.revision}`,
            )
          : null,
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-1.5' },
          bound.alive
            ? h(
                Button,
                {
                  size: 'xs',
                  disabled: busy,
                  onClick: () => run(() => app.rpc.call('open', { environmentId }), '打开 Whistle 面板失败'),
                },
                '打开 Web UI',
              )
            : h(
                Button,
                {
                  size: 'xs',
                  disabled: busy,
                  onClick: () =>
                    run(() => app.rpc.call('start', { storage: bound.storage }), '启动实例失败').then(loadBoundDetails),
                },
                '启动实例',
              ),
          h(
            Button,
            {
              size: 'xs',
              variant: 'ghost',
              disabled: busy,
              onClick: () => {
                load();
                loadBoundDetails();
              },
            },
            '刷新',
          ),
        ),
      ),
      bound.alive
        ? h(
            'div',
            { className: 'flex flex-col gap-1.5' },
            h('span', { className: 'text-[11px] font-medium text-muted-foreground' }, `规则组（${groups.length}）`),
            groups.length === 0
              ? h('p', { className: 'text-muted-foreground' }, '暂无规则组。')
              : h(
                  'div',
                  { className: 'flex flex-col gap-1.5' },
                  ...groups.map((grp) =>
                    h(
                      'div',
                      {
                        key: grp.name,
                        className: cn(cardSurfaceClass, 'flex items-center justify-between gap-2 py-1.5'),
                      },
                      h('span', { className: 'truncate font-mono' }, grp.name),
                      h(Switch, {
                        checked: Boolean(grp.selected),
                        disabled: busy,
                        'aria-label': `切换规则组 ${grp.name}`,
                        onCheckedChange: (checked) =>
                          void run(
                            () =>
                              app.rpc.call('ruleToggle', {
                                storage: bound.storage,
                                name: grp.name,
                                enabled: Boolean(checked),
                              }),
                            '切换规则组失败',
                          ).then(loadBoundDetails),
                      }),
                    ),
                  ),
                ),
          )
        : null,
    );
  }

  app.surfaces.railPage({ id: 'proxy', title: '代理', icon: 'Globe', path: 'proxy', component: ProxyPage });
  app.surfaces.inspectorTab({ id: 'env-proxy', title: '代理', component: WhistleInspectorTab });
  app.surfaces.settingsSection({ id: 'about', title: 'Whistle 使用说明', component: AboutSection });
}
