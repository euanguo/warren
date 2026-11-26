import type { BrowserWindow } from 'electron';
import type { BrowserController } from './browser/controller.ts';
import type { CookieFilter, CookieInput, CookieSummary } from './browser/cookies.ts';
import { wireDownloads } from './browser/downloads.ts';
import { acquireLease, makeEvent, releaseLease, type EnvironmentPatch } from './domain/environment.ts';
import { LeaseCoordinator, type LeaseHandle } from './env/lease-coordinator.ts';
import { EnvLifecycle, SPACE_IDS } from './env/lifecycle.ts';
import { EnvSessionFactory } from './env/session-factory.ts';
import { EnvViewCoordinator } from './env/view-coordinator.ts';
import { InputShield } from './input-shield.ts';
import type { Store } from './store.ts';
import { newTabUrl, type TabListItem } from './tabs.ts';
import type { ConsoleEntry, NetworkEntry } from './telemetry.ts';
import type { WindowLayerManager } from './ui/layer-manager.ts';
import type {
  BrowserShortcut,
  Creator,
  DevToolsDockMode,
  DownloadItemInfo,
  Environment,
  EnvironmentSpace,
  FindInPageResult,
  Group,
  NavigationAction,
  NavigationState,
  PluginBusEvent,
  PluginBusEventType,
  AppSettings,
  SpaceId,
  TabRef,
  ViewportPresetId,
  ViewportRect,
} from '../shared/types.ts';

export type { LeaseHandle };

export interface EnvironmentManagerOptions {
  layers?: WindowLayerManager;
  onTargetUrl?: (payload: { envId: string; url: string }) => void;
  onFindResult?: (result: FindInPageResult) => void;
  onDownloadsChanged?: () => void;
  onBusEvent?: (event: PluginBusEvent) => void;
}

function spaceLabel(space: SpaceId): string {
  return space === 'person' ? '我的空间' : 'Agent 空间';
}

export class EnvironmentManager {
  #store: Store;
  #window: BrowserWindow;
  #onChange: () => void;
  #options: EnvironmentManagerOptions;
  #sessions: EnvSessionFactory;
  #leases: LeaseCoordinator;
  #views: EnvViewCoordinator;
  #lifecycle: EnvLifecycle;

  constructor(store: Store, window: BrowserWindow, onChange: () => void, options: EnvironmentManagerOptions = {}) {
    this.#store = store;
    this.#window = window;
    this.#onChange = onChange;
    this.#options = options;

    this.#sessions = new EnvSessionFactory({
      store,
      onChange,
      emitBusEvent: (type, envId, payload) => this.#emitBusEvent(type, envId, payload),
    });

    this.#views = new EnvViewCoordinator({
      window,
      layers: options.layers,
      store,
      getSpaces: (id) => this.#lifecycle.spacesFor(id),
      allSpacesEntries: () => this.#lifecycle.allSpacesEntries(),
      getSpaceManager: (id, space) => this.#lifecycle.spaceManager(id, space),
      getActiveSpace: (id) => this.#lifecycle.activeSpaceOf(id),
      touch: (id) => this.#lifecycle.touch(id),
      rememberRunning: () => this.#lifecycle.rememberRunning(),
      rememberTabs: (id) => this.#lifecycle.rememberTabs(id),
      onSpaceEmpty: (id, space) => this.#lifecycle.onSpaceEmpty(id, space),
      onChange,
      onTargetUrl: options.onTargetUrl,
      onFindResult: options.onFindResult,
      emitBusEvent: (type, envId, payload) => this.#emitBusEvent(type, envId, payload),
      attachTabTelemetry: (envId, tabId, wc) => this.#sessions.attachTabTelemetry(envId, tabId, wc),
      detachTabTelemetry: (tabId) => this.#sessions.detachTabTelemetry(tabId),
      lastActivityAt: (tabId) => this.#sessions.lastActivityAt(tabId),
      syncShield: (id, syncOptions) => this.#leases.syncShield(id, syncOptions),
      detachShieldOnly: (id) => this.#leases.detachShieldOnly(id),
      repositionShield: (id, bounds) => this.#leases.repositionShield(id, bounds),
      setShieldVisible: (id, visible) => this.#leases.setShieldVisible(id, visible),
      isAgentControlling: (id) => this.#leases.isAgentControlling(id),
      canHumanNavigate: (id, space) => this.#leases.canHumanNavigate(id, space),
      assertAgentHumanWritable: (id) => this.#leases.assertHumanAgentWritable(id),
      getLayoutExtra: (selected) => {
        const lease = selected ? this.#leases.rawLease(selected) : undefined;
        return {
          telemetryWrite: this.#sessions.telemetryWriteStats,
          maxRunning: this.#lifecycle.maxRunning,
          shieldAttached: selected ? this.#leases.shieldAttached(selected) : false,
          owner: lease && lease.expiresAt > Date.now() ? lease.owner : 'none',
        };
      },
    });

    this.#leases = new LeaseCoordinator({
      getEnvironment: (id) => this.get(id),
      getConfig: (id) => this.#store.configFor(id),
      getControlPolicy: () => this.#store.appSettings().controlPolicy,
      getSpaceManager: (id, space) => this.#lifecycle.spaceManager(id, space),
      getSelectedId: () => this.#views.selected,
      getActiveSpace: (id) => this.#lifecycle.activeSpaceOf(id),
      getViewVisible: () => this.#views.viewVisible,
      getPageBounds: () => this.#views.pageBounds(),
      getViewportSize: () => this.#views.viewport,
      selectSpaceView: (id, space) => this.#views.select(id, space),
      restoreDisplayedFocus: (selected) => this.#views.restoreDisplayedFocus(selected),
      touch: (id) => this.#lifecycle.touch(id),
      recordEvent: (type, message, actor, envId) => this.#store.record(makeEvent(type, message, actor, envId)),
      onChange,
      emitBusEvent: (type, envId, payload) => this.#emitBusEvent(type, envId, payload),
      createShield: (_id, onTakeover) => new InputShield({ layers: this.#views.layers, onTakeover }),
      attachAndRaiseShield: (shield, bounds) => {
        const inputShield = shield as InputShield;
        inputShield.attach(this.#window, bounds);
        inputShield.raise(this.#window);
      },
      detachShield: (shield) => (shield as InputShield).detach(this.#window),
    });

    this.#lifecycle = new EnvLifecycle({
      store,
      prepareSession: (id, config) => this.#sessions.prepareSession(id, config),
      prepareWakeSession: (id, config) => this.#sessions.prepareWakeSession(id, config),
      clearStorageData: (id) => this.#sessions.clearStorageData(id),
      dropNet: (id) => this.#sessions.drop(id),
      wireDownloads: (ses, id, pendingFor) =>
        wireDownloads(
          ses,
          id,
          pendingFor,
          (type, message) => this.#store.record(makeEvent(type, message, 'system', id)),
          () => this.#options.onDownloadsChanged?.(),
        ),
      attachSessionTelemetry: (ses) => this.#sessions.attachSessionTelemetry(ses),
      detachNet: (id) => this.#sessions.detachNet(id),
      detachTelemetry: (id) => this.#sessions.detachTelemetry(id),
      isNetBusy: (id) => this.#sessions.isNetBusy(id),
      createSpaceManager: (id, space, ses, trustedCa, pending) =>
        this.#views.createSpaceManager(id, space, ses, trustedCa, pending),
      newTabUrl,
      decorate: (env) => this.#decorate(env),
      selectEnv: (id) => this.#views.select(id),
      clearSelectedIf: (id) => this.#views.clearSelectedIf(id),
      getSelectedId: () => this.#views.selected,
      hasLiveLease: (id) => this.#leases.hasLiveLease(id),
      clearLeaseAndShield: (id) => this.#leases.clearEnv(id),
      closeEnvDevTools: (spaces) => this.#views.closeEnvDevTools(spaces),
      destroyAllDevTools: () => this.#views.destroyAllDevTools(),
      onChange,
      emitBusEvent: (type, envId, payload) => this.#emitBusEvent(type, envId, payload),
    });
  }

  // ── 视图、标签、窗口与导航 ─────────────────────────────────────────

  selectSpace(id: string, space: SpaceId): void {
    this.#views.selectSpace(id, space);
  }
  select(id: string, space?: SpaceId): void {
    this.#views.select(id, space);
  }
  selectedId(): string | undefined {
    return this.#views.selected;
  }
  setViewport(viewport: ViewportRect): void {
    this.#views.setViewport(viewport);
  }
  capturePage(): Promise<string | null> {
    return this.#views.capturePage();
  }
  setViewVisible(visible: boolean): void {
    this.#views.setViewVisible(visible);
  }
  openDevTools(id: string, space: SpaceId = 'agent', dock?: DevToolsDockMode): void {
    this.#views.openDevTools(id, space, dock);
  }
  closeDevTools(id: string, space: SpaceId = 'agent'): void {
    this.#views.closeDevTools(id, space);
  }
  inspectAt(id: string, space: SpaceId, x: number, y: number): void {
    this.#views.inspectAt(id, space, x, y);
  }
  setDevToolsDock(dock: DevToolsDockMode, size?: number): void {
    this.#views.setDevToolsDock(dock, size);
  }
  getDevToolsState(): { open: boolean; dock: DevToolsDockMode; size: number } {
    return this.#views.getDevToolsState();
  }
  findInPage(id: string, space: SpaceId, text: string, options: { forward?: boolean; findNext?: boolean } = {}): void {
    this.#views.findInPage(id, space, text, options);
  }
  stopFindInPage(id: string, space: SpaceId): void {
    this.#views.stopFindInPage(id, space);
  }
  setZoom(id: string, space: SpaceId, mode: 'in' | 'out' | 'reset' | number): { factor: number } {
    return this.#views.setZoom(id, space, mode);
  }
  getZoom(id: string, space: SpaceId): { factor: number } {
    return this.#views.getZoom(id, space);
  }
  setViewportPreset(id: string, space: SpaceId, preset: ViewportPresetId): Promise<{ preset: ViewportPresetId }> {
    return this.#views.setViewportPreset(id, space, preset);
  }
  getViewportPreset(id: string, space: SpaceId): { preset: ViewportPresetId } {
    return this.#views.getViewportPreset(id, space);
  }
  downloads(id?: string): DownloadItemInfo[] {
    return this.#views.downloads(id);
  }
  revealDownload(downloadId: string): void {
    this.#views.revealDownload(downloadId);
  }
  printPage(id: string, space: SpaceId): void {
    this.#views.printPage(id, space);
  }
  savePageAs(id: string, space: SpaceId): Promise<{ saved: boolean; path?: string }> {
    return this.#views.savePageAs(id, space);
  }
  focusWindow(): { x: number; y: number; width: number; height: number } {
    return this.#views.focusWindow();
  }
  hideWindow(): void {
    this.#views.hideWindow();
  }
  backgroundWindow(): void {
    this.#views.backgroundWindow();
  }
  showWindow(focus = false): void {
    this.#views.showWindow(focus);
  }
  focusDisplayedPage(id?: string): void {
    this.#views.focusDisplayedPage(id);
  }
  focusForInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    return this.#views.focusForInput(id, space);
  }
  evalInRenderer<T = unknown>(script: string): Promise<T> {
    return this.#views.evalInRenderer<T>(script);
  }
  sendShortcut(shortcut: BrowserShortcut): void {
    this.#views.sendShortcut(shortcut);
  }
  layout() {
    return this.#views.layout();
  }
  controllerFor(id: string, ref?: TabRef, space: SpaceId = 'agent'): BrowserController {
    return this.#views.controllerFor(id, ref, space);
  }
  tabsOf(id: string, space?: SpaceId): TabListItem[] {
    return this.#views.tabsOf(id, space);
  }
  newTab(id: string, url?: string, options?: { activate?: boolean }, space?: SpaceId): TabListItem {
    return this.#views.newTab(id, url, options, space);
  }
  muteTab(id: string, space: SpaceId, ref: TabRef, muted: boolean): TabListItem {
    return this.#views.muteTab(id, space, ref, muted);
  }
  reorderTab(id: string, space: SpaceId, from: number, to: number): TabListItem[] {
    return this.#views.reorderTab(id, space, from, to);
  }
  closeTabs(id: string, space: SpaceId, ref: TabRef, mode: 'others' | 'right'): void {
    this.#views.closeTabs(id, space, ref, mode);
  }
  reopenTab(id: string, space?: SpaceId): TabListItem {
    return this.#views.reopenTab(id, space);
  }
  selectTab(id: string, space: SpaceId, ref: TabRef): TabListItem {
    return this.#views.selectTab(id, space, ref);
  }
  closeTab(id: string, space: SpaceId, ref: TabRef): void {
    this.#views.closeTab(id, space, ref);
  }
  navState(id: string, space?: SpaceId): NavigationState | undefined {
    return this.#views.navState(id, space);
  }
  humanNavigate(id: string, action: NavigationAction, space?: SpaceId): NavigationState {
    return this.#views.humanNavigate(id, action, space);
  }

  // ── 遥测 / 网络拦截 / 扩展 / Cookie ────────────────────────────────

  consoleEntries(id: string): ConsoleEntry[] {
    return this.#sessions.consoleEntries(id);
  }
  networkEntries(id: string): NetworkEntry[] {
    return this.#sessions.networkEntries(id);
  }
  netRules(id: string) {
    return this.#sessions.netRules(id);
  }
  netHits(id: string, limit?: number) {
    return this.#sessions.netHits(id, limit);
  }
  netAddRule(id: string, input: unknown, actor: 'agent' | 'human') {
    return this.#sessions.netAddRule(id, input, actor);
  }
  netPassthrough(
    id: string,
    input: { match: string; isRegex?: boolean; method?: string; forMs: number },
    actor: 'agent' | 'human',
  ) {
    return this.#sessions.netPassthrough(id, input, actor);
  }
  netSetRuleEnabled(id: string, ruleId: string, enabled: boolean, actor: 'agent' | 'human') {
    return this.#sessions.netSetRuleEnabled(id, ruleId, enabled, actor);
  }
  netRemoveRule(id: string, ruleId: string, actor: 'agent' | 'human') {
    return this.#sessions.netRemoveRule(id, ruleId, actor);
  }
  netRecord(id: string, action: string, output: string | undefined, actor: 'agent' | 'human') {
    return this.#sessions.netRecord(id, action, output, actor);
  }
  netReplay(id: string, action: string, file: string | undefined, offline: boolean, actor: 'agent' | 'human') {
    return this.#sessions.netReplay(id, action, file, offline, actor);
  }
  netBody(id: string, index: number) {
    return this.#sessions.netBody(id, index);
  }
  extensionsOf(id: string): Promise<{ id: string; dir: string }[]> {
    return this.#sessions.extensionsOf(id);
  }
  extensionAdd(id: string, srcDir: string, name?: string): Promise<{ id: string; dir: string }> {
    return this.#sessions.extensionAdd(id, srcDir, name);
  }
  extensionRemove(id: string, name: string): Promise<{ removed: boolean }> {
    return this.#sessions.extensionRemove(id, name);
  }
  cookieNames(id: string, url?: string): Promise<CookieSummary[]> {
    return this.#sessions.cookieNames(id, url);
  }
  cookieCopy(from: string, to: string, filter: CookieFilter = {}): Promise<{ copied: number; names: string[] }> {
    return this.#sessions.cookieCopy(from, to, filter);
  }
  cookieImport(id: string, cookies: CookieInput[]): Promise<{ written: number; names: string[] }> {
    return this.#sessions.cookieImport(id, cookies);
  }
  cookieClear(id: string, filter: CookieFilter = {}): Promise<{ removed: number }> {
    return this.#sessions.cookieClear(id, filter);
  }

  // ── 环境生命周期与分组配置 ─────────────────────────────────────────

  list(): Environment[] {
    return this.#store.list().map((env) => this.#decorate(env));
  }
  get(id: string): Environment | undefined {
    const env = this.#store.get(id);
    return env ? this.#decorate(env) : undefined;
  }
  create(input: {
    id: string;
    name?: string;
    proxy?: string;
    startUrl?: string;
    headed?: boolean;
    createdBy?: Creator;
  }): Promise<Environment> {
    return this.#lifecycle.create(input);
  }
  remove(id: string): Promise<void> {
    return this.#lifecycle.remove(id);
  }
  update(id: string, patch: EnvironmentPatch): Promise<Environment> {
    return this.#lifecycle.update(id, patch);
  }
  start(id: string): Promise<Environment> {
    return this.#lifecycle.start(id);
  }
  stop(id: string): void {
    this.#lifecycle.stop(id);
  }
  hibernate(id: string, reason = 'manual'): boolean {
    return this.#lifecycle.hibernate(id, reason);
  }
  wake(id: string): boolean {
    return this.#lifecycle.wake(id);
  }
  isDormant(id: string): boolean {
    return this.#lifecycle.isDormant(id);
  }
  shutdown(): void {
    this.#lifecycle.shutdown();
  }
  hasRunningEnvironments(): boolean {
    return this.#lifecycle.hasRunningEnvironments();
  }
  restoreRunning(ids: string[], selected?: string): Promise<string[]> {
    return this.#lifecycle.restoreRunning(ids, selected);
  }
  get maxRunning(): number {
    return this.#lifecycle.maxRunning;
  }
  get selected(): string | undefined {
    return this.#views.selected;
  }

  listGroups(): Group[] {
    return this.#store.listGroups();
  }
  async createGroup(input: { id?: string; name: string }): Promise<Group> {
    const group = await this.#store.createGroup(input);
    this.#recordAndNotify('group.created', `group ${group.name} created`);
    return group;
  }
  async renameGroup(id: string, name: string): Promise<Group> {
    const group = await this.#store.renameGroup(id, name);
    this.#recordAndNotify('group.renamed', `group ${id} renamed to ${group.name}`);
    return group;
  }
  async setGroupCollapsed(id: string, collapsed: boolean): Promise<Group> {
    const group = await this.#store.setGroupCollapsed(id, collapsed);
    this.#onChange();
    return group;
  }
  async removeGroup(id: string): Promise<{ detached: number }> {
    const result = await this.#store.removeGroup(id);
    this.#recordAndNotify('group.removed', `group ${id} removed, ${result.detached} environment(s) detached`);
    return result;
  }
  async reorderGroups(orderedIds: string[]): Promise<void> {
    await this.#store.reorderGroups(orderedIds);
    this.#onChange();
  }
  async moveToGroup(environmentId: string, groupId: string | undefined): Promise<Environment> {
    const moved = await this.#store.moveToGroup(environmentId, groupId);
    this.#recordAndNotify(
      'environment.moved',
      `environment ${environmentId} moved to ${groupId ?? '未分组'}`,
      environmentId,
    );
    return this.#decorate(moved);
  }
  async reorderEnvironments(groupId: string | undefined, orderedIds: string[]): Promise<void> {
    await this.#store.reorderEnvironments(groupId, orderedIds);
    this.#onChange();
  }

  // ── 控制权与输入就绪 ───────────────────────────────────────────────

  acquire(id: string, owner: 'agent' | 'human', label?: string, space: SpaceId = 'agent'): LeaseHandle {
    return this.#leases.acquire(id, owner, label, space);
  }
  release(id: string, leaseId: string, actor: 'agent' | 'human' = 'agent'): void {
    this.#leases.release(id, leaseId, actor);
  }
  takeover(id: string, label = 'human', space: SpaceId = 'agent'): LeaseHandle {
    return this.#leases.takeover(id, label, space);
  }
  ensureOperable(id: string, space: SpaceId = 'agent'): boolean {
    return this.#leases.ensureOperable(id, space);
  }
  detachOperable(id: string, space: SpaceId = 'agent'): void {
    this.#leases.detachOperable(id, space);
  }
  assertInputOnScreen(id: string, space: SpaceId = 'agent'): void {
    this.#leases.assertInputOnScreen(id, space);
  }
  prepareBackgroundInput(id: string, space: SpaceId = 'agent'): Promise<boolean> {
    return this.#leases.prepareBackgroundInput(id, space);
  }
  clearBackgroundInput(id: string, space: SpaceId = 'agent'): Promise<void> {
    return this.#leases.clearBackgroundInput(id, space);
  }
  assertWritable(id: string, leaseId?: string, space: SpaceId = 'agent'): LeaseHandle {
    return this.#leases.assertWritable(id, leaseId, space);
  }
  renew(id: string, leaseId: string): LeaseHandle {
    return this.#leases.renew(id, leaseId);
  }
  assertActiveTab(id: string, ref?: TabRef, space: SpaceId = 'agent'): void {
    this.#leases.assertActiveTab(id, ref, space);
  }
  hasActiveAgentLease(): boolean {
    return this.#leases.hasActiveAgentLease();
  }

  /** 将最新应用级设置同步到各运行期协作者，使设置修改即刻生效。 */
  applySettings(settings: AppSettings, options: { respectEnvOverrides?: boolean } = {}): void {
    const useEnv = Boolean(options.respectEnvOverrides);
    this.#lifecycle.setLimits({
      maxRunning: useEnv && process.env.WARREN_MAX_RUNNING !== undefined ? undefined : settings.maxRunning,
      idleMinutes: useEnv && process.env.WARREN_IDLE_MS !== undefined ? undefined : settings.idleHibernateMinutes,
    });
    if (!useEnv || process.env.WARREN_LEASE_TTL_MS === undefined) {
      this.#leases.setLeaseTtlMs(settings.leaseTtlMs);
    }
    if (settings.showControlPill !== undefined) {
      this.#leases.setShowControlPill(settings.showControlPill);
    }
    this.#views.setDefaultPreferences({
      dock: settings.devtoolsDefaultDock,
      defaultViewport: settings.devtoolsDefaultViewport,
      pageBorderRadius: settings.pageBorderRadius,
    });
  }

  // ── 内部装配 ───────────────────────────────────────────────────────

  #recordAndNotify(type: string, message: string, environmentId?: string): void {
    this.#store.record(makeEvent(type, message, 'human', environmentId));
    this.#onChange();
  }

  #emitBusEvent(type: PluginBusEventType, environmentId: string, payload: Record<string, unknown>): void {
    const listener = this.#options.onBusEvent;
    if (!listener) return;
    try {
      listener({ type, environmentId, at: new Date().toISOString(), payload });
    } catch {
      // 事件订阅方抛错不能破坏主流程
    }
  }

  #spaceStates(id: string): EnvironmentSpace[] {
    const spaces = this.#lifecycle.spacesFor(id);
    if (!spaces) return [];
    return SPACE_IDS.map((space) => {
      const manager = spaces[space];
      return {
        id: space,
        label: spaceLabel(space),
        owner: this.#leases.spaceOwner(id, space),
        tabs: manager.list(),
        activeTabId: manager.activeId,
      };
    });
  }

  #decorate(env: Environment): Environment {
    const lease = this.#leases.pruneAndGetLiveLease(env.id);
    const spaces = this.#lifecycle.spacesFor(env.id);
    const activeSpaceId = spaces?.active ?? 'person';
    const tabs = spaces?.[activeSpaceId];
    const active = tabs?.active()?.state;
    return {
      ...env,
      status: spaces ? 'running' : this.#lifecycle.isDormant(env.id) ? 'dormant' : 'stopped',
      owner: lease ? lease.owner : 'none',
      leaseId: lease?.leaseId,
      leaseLabel: lease?.label,
      leaseExpiresAt: lease?.expiresAt,
      currentUrl: active?.url || env.currentUrl,
      title: active?.title || env.title,
      error: active?.error,
      tabs: tabs?.list(),
      activeTabId: tabs?.activeId,
      activeSpaceId,
      spaces: this.#spaceStates(env.id),
    };
  }
}

export { acquireLease, releaseLease };
