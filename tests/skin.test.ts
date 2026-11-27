import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  SKIN_COLOR_KEYS,
  deriveSkinCssVars,
  isSkinId,
  resolveSkinPalette,
  sanitizeSkinColorPatch,
  sanitizeSkinOverrides,
  validateSkinOverridesInput,
} from '../src/shared/skin.ts';
import { DEFAULT_APP_SETTINGS, toAppSettings } from '../src/main/domain/approval.ts';

test('皮肤只允许修改 12 个 Hex 配色键，结构性 Token 键会被严格过滤', () => {
  const dirty = {
    accent: '#FF6600',
    canvas: '#121212',
    radius: '24px',
    fontSize: '18px',
    controlHeight: '44px',
    spacing: '12px',
    border: 'not-a-hex',
    frame: '#fff',
  };
  const clean = sanitizeSkinColorPatch(dirty);
  assert.deepEqual(clean, {
    accent: '#ff6600',
    canvas: '#121212',
  });

  const validated = validateSkinOverridesInput({
    dark: {
      accent: '#22c55e',
      radiusCard: '99px',
      fontSans: 'Comic Sans',
    },
    light: {
      canvas: '#fefefe',
      durationHover: '500ms',
    },
    spacingScale: 2,
  });
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.deepEqual(validated.overrides, {
      dark: { accent: '#22c55e' },
      light: { canvas: '#fefefe' },
    });
    assert.deepEqual(validated.ignoredKeys.sort(), [
      'dark.fontSans',
      'dark.radiusCard',
      'light.durationHover',
      'spacingScale',
    ]);
  }
});

test('deriveSkinCssVars 只输出颜色类 CSS 变量，绝不覆盖圆角/字体/高度/动效等基础 Token', () => {
  for (const skin of BUILTIN_SKINS) {
    for (const scheme of ['dark', 'light'] as const) {
      const palette = resolveSkinPalette(skin.id, scheme);
      for (const key of SKIN_COLOR_KEYS) {
        assert.match(palette[key], /^#[0-9a-f]{6}$/i, `${skin.id}.${scheme}.${key}`);
      }
      const vars = deriveSkinCssVars(palette, scheme);
      assert.equal(vars['--bg-canvas'], palette.canvas);
      assert.equal(vars['--bg-frame'], palette.frame);
      assert.equal(vars['--accent-seed'], palette.accent);
      for (const name of Object.keys(vars)) {
        assert.ok(
          !/^--(radius|font|text-size|leading|space|control-|duration|ease|layer|shell-|sidebar-width|switch-)/i.test(
            name,
          ),
          `皮肤不允许覆盖基础结构 Token: ${name}`,
        );
      }
    }
  }
});

test('toAppSettings 规范化 skin 与 skinOverrides，非法值安全退回默认皮肤', () => {
  assert.equal(isSkinId(DEFAULT_SKIN_ID), true);
  assert.equal(isSkinId('unknown-skin'), false);
  assert.deepEqual(toAppSettings({}), DEFAULT_APP_SETTINGS);

  const parsed = toAppSettings({
    skin: 'paper',
    skinOverrides: JSON.stringify({
      dark: { accent: '#12ab34', radius: '99px' },
      light: { surface: '#fffffa' },
    }),
  });
  assert.equal(parsed.skin, 'paper');
  assert.deepEqual(parsed.skinOverrides, {
    dark: { accent: '#12ab34' },
    light: { surface: '#fffffa' },
  });

  const fallback = toAppSettings({
    skin: 'nonexistent',
    skinOverrides: '{broken json',
  });
  assert.equal(fallback.skin, DEFAULT_SKIN_ID);
  assert.deepEqual(fallback.skinOverrides, {});
  assert.deepEqual(sanitizeSkinOverrides(['invalid']), {});
});
