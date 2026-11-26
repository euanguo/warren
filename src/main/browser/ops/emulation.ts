/**
 * 浏览器设备与环境仿真：`browser.set`（viewport / device / geo / offline / headers / media / tz / locale / reset）。
 * 全部走 CDP `Emulation.*` / `Network.*`，由 RPC 写门控保护。
 */
import type { PageContext } from '../ctx.ts';
import { richErr } from '../errors.ts';

export interface DevicePreset {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  userAgent: string;
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  'iphone-15': {
    name: 'iPhone 15',
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  'pixel-8': {
    name: 'Pixel 8',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
  ipad: {
    name: 'iPad Air',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  'desktop-1440': {
    name: 'Desktop 1440',
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    userAgent: '',
  },
  'desktop-1280': {
    name: 'Desktop 1280',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    userAgent: '',
  },
};

export type EmulationSetting =
  | { kind: 'viewport'; width: number; height: number; dpr?: number; mobile?: boolean }
  | { kind: 'device'; device: string }
  | { kind: 'geo'; latitude: number; longitude: number; accuracy?: number }
  | { kind: 'offline'; offline: boolean }
  | { kind: 'headers'; headers: Record<string, string> }
  | { kind: 'media'; colorScheme?: 'dark' | 'light' | 'no-preference'; reducedMotion?: 'reduce' | 'no-preference' }
  | { kind: 'tz'; timezoneId: string }
  | { kind: 'locale'; locale: string }
  | { kind: 'reset' };

/** 按子类型应用或重置浏览器仿真参数。 */
export async function applyEmulationSetting(
  ctx: PageContext,
  setting: EmulationSetting,
): Promise<Record<string, unknown>> {
  switch (setting.kind) {
    case 'viewport': {
      const width = Math.max(100, Math.min(7680, Math.round(setting.width)));
      const height = Math.max(100, Math.min(4320, Math.round(setting.height)));
      const deviceScaleFactor = setting.dpr && setting.dpr > 0 ? setting.dpr : 1;
      const mobile = Boolean(setting.mobile);
      await ctx.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile,
      });
      return { ok: true, kind: 'viewport', width, height, dpr: deviceScaleFactor, mobile };
    }
    case 'device': {
      const key = setting.device.trim().toLowerCase().replace(/\s+/g, '-');
      const preset = DEVICE_PRESETS[key];
      if (!preset) {
        throw richErr(
          'BAD_REQUEST',
          `未知设备预设：${setting.device}（可选：${Object.keys(DEVICE_PRESETS).join(', ')}）`,
        );
      }
      await ctx.send('Emulation.setDeviceMetricsOverride', {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.deviceScaleFactor,
        mobile: preset.mobile,
      });
      await ctx.send('Emulation.setTouchEmulationEnabled', { enabled: preset.hasTouch }).catch(() => {});
      if (preset.userAgent) {
        await ctx.send('Emulation.setUserAgentOverride', { userAgent: preset.userAgent }).catch(() => {});
      }
      return { ok: true, kind: 'device', preset: preset.name, width: preset.width, height: preset.height };
    }
    case 'geo': {
      if (!Number.isFinite(setting.latitude) || !Number.isFinite(setting.longitude)) {
        throw richErr('BAD_REQUEST', 'geo 需要合法的 latitude 与 longitude');
      }
      await ctx.send('Emulation.setGeolocationOverride', {
        latitude: setting.latitude,
        longitude: setting.longitude,
        accuracy: setting.accuracy ?? 50,
      });
      return { ok: true, kind: 'geo', latitude: setting.latitude, longitude: setting.longitude };
    }
    case 'offline': {
      await ctx.send('Network.emulateNetworkConditions', {
        offline: setting.offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      return { ok: true, kind: 'offline', offline: setting.offline };
    }
    case 'headers': {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(setting.headers ?? {})) {
        if (!k.trim()) continue;
        clean[k.trim()] = String(v);
      }
      await ctx.send('Network.setExtraHTTPHeaders', { headers: clean });
      return { ok: true, kind: 'headers', count: Object.keys(clean).length };
    }
    case 'media': {
      const features: Array<{ name: string; value: string }> = [];
      if (setting.colorScheme) features.push({ name: 'prefers-color-scheme', value: setting.colorScheme });
      if (setting.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: setting.reducedMotion });
      await ctx.send('Emulation.setEmulatedMedia', { features });
      return {
        ok: true,
        kind: 'media',
        colorScheme: setting.colorScheme ?? null,
        reducedMotion: setting.reducedMotion ?? null,
      };
    }
    case 'tz': {
      if (!setting.timezoneId.trim()) throw richErr('BAD_REQUEST', 'tz 不能为空（示例：Asia/Shanghai 或 UTC）');
      await ctx.send('Emulation.setTimezoneOverride', { timezoneId: setting.timezoneId.trim() });
      return { ok: true, kind: 'tz', timezoneId: setting.timezoneId.trim() };
    }
    case 'locale': {
      if (!setting.locale.trim()) throw richErr('BAD_REQUEST', 'locale 不能为空（示例：zh-CN 或 en-US）');
      await ctx.send('Emulation.setLocaleOverride', { locale: setting.locale.trim() });
      return { ok: true, kind: 'locale', locale: setting.locale.trim() };
    }
    case 'reset': {
      await ctx.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await ctx.send('Emulation.clearGeolocationOverride').catch(() => {});
      await ctx.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
      await ctx.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      await ctx.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
      await ctx.send('Emulation.setLocaleOverride', { locale: '' }).catch(() => {});
      await ctx
        .send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        .catch(() => {});
      await ctx.send('Network.setExtraHTTPHeaders', { headers: {} }).catch(() => {});
      return { ok: true, kind: 'reset' };
    }
  }
}
