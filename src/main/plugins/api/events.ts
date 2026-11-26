/**
 * 插件日志 / 事件 / 信号 / 通知 host API。
 */
import type { CapabilitySpec } from './index.ts';

export const eventsCapabilities: Record<string, CapabilitySpec> = {
  'log.debug': {
    handler: ({ deps, text }, ...args) => deps.log('debug', args.map(text).join(' ')),
  },
  'log.info': {
    handler: ({ deps, text }, ...args) => deps.log('info', args.map(text).join(' ')),
  },
  'log.warn': {
    handler: ({ deps, text }, ...args) => deps.log('warn', args.map(text).join(' ')),
  },
  'log.error': {
    handler: ({ deps, text }, ...args) => deps.log('error', args.map(text).join(' ')),
  },
  'events.emit': {
    handler: ({ deps, text }, type, message) => {
      deps.record(text(type), text(message));
      return { ok: true };
    },
  },
  'events.subscribe': {
    permission: 'events.subscribe',
    handler: ({ deps }, filter) => {
      if (!deps.subscribeEvents) {
        throw Object.assign(new Error('事件总线不可用'), { code: 'PLUGIN_EVENT_BUS_UNAVAILABLE' });
      }
      return deps.subscribeEvents(filter ?? {});
    },
  },
  'events.unsubscribe': {
    permission: 'events.subscribe',
    handler: async ({ deps, text }, subscriptionId) => {
      if (!deps.unsubscribeEvents) {
        throw Object.assign(new Error('事件总线不可用'), { code: 'PLUGIN_EVENT_BUS_UNAVAILABLE' });
      }
      await deps.unsubscribeEvents(text(subscriptionId));
      return { ok: true };
    },
  },
  'ui.notify': {
    handler: ({ deps, text }, message) => {
      deps.record('plugin.notify', text(message));
      return { ok: true };
    },
  },
  'signal.publish': {
    handler: ({ deps, text }, channel, payload) => {
      deps.signal(text(channel), payload ?? null);
      return { ok: true };
    },
  },
};
