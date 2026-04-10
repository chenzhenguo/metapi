import { asc, eq, gt } from 'drizzle-orm';
import cron from 'node-cron';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { mergeAccountExtraConfig } from './accountExtraConfig.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { PLATFORM_ALIASES, detectPlatformByUrlHint } from '../../shared/platformIdentity.js';

const BACKUP_VERSION = '2.1';

const DEFAULT_BATCH_SIZE = 100;
const LOGS_BATCH_SIZE = 1000;

async function batchQueryAll(
  table: any,
  dbInstance: typeof db,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<any[]> {
  const results: any[] = [];
  let lastId: number | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const query = lastId === undefined
      ? dbInstance.select().from(table)
      : dbInstance.select().from(table).where(gt(table.id, lastId));

    const batch = await query.limit(batchSize).all();
    
    if (batch.length === 0) {
      hasMore = false;
    } else {
      results.push(...batch);
      lastId = batch[batch.length - 1].id;
      hasMore = batch.length === batchSize;
    }
  }

  return results;
}

async function batchInsertHelper<T extends Record<string, unknown>>(
  tx: any,
  table: any,
  records: T[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<void> {
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await tx.insert(table).values(batch).run();
  }
}

export type BackupExportType = 'all' | 'accounts' | 'preferences';

export interface BackupWebdavConfig {
  enabled: boolean;
  fileUrl: string;
  username: string;
  password: string;
  exportType: BackupExportType;
  autoSyncEnabled: boolean;
  autoSyncCron: string;
}

export interface BackupWebdavConfigView {
  enabled: boolean;
  fileUrl: string;
  username: string;
  exportType: BackupExportType;
  autoSyncEnabled: boolean;
  autoSyncCron: string;
  hasPassword: boolean;
  passwordMasked: string;
}

export interface BackupWebdavState {
  lastSyncAt: string | null;
  lastError: string | null;
}

type SiteRow = typeof schema.sites.$inferSelect;
type SiteApiEndpointRow = typeof schema.siteApiEndpoints.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type AccountTokenRow = typeof schema.accountTokens.$inferSelect;
type TokenRouteRow = typeof schema.tokenRoutes.$inferSelect;
type RouteChannelRow = typeof schema.routeChannels.$inferSelect;
type RouteGroupSourceRow = typeof schema.routeGroupSources.$inferSelect;
type SiteDisabledModelRow = typeof schema.siteDisabledModels.$inferSelect;
type ModelAvailabilityRow = typeof schema.modelAvailability.$inferSelect;
type TokenModelAvailabilityRow = typeof schema.tokenModelAvailability.$inferSelect;
type ProxyLogRow = typeof schema.proxyLogs.$inferSelect;
type CheckinLogRow = typeof schema.checkinLogs.$inferSelect;
type DownstreamApiKeyRow = typeof schema.downstreamApiKeys.$inferSelect;
type SiteAnnouncementRow = typeof schema.siteAnnouncements.$inferSelect;

type BackupAccountRow = Omit<AccountRow, 'balanceUsed' | 'lastCheckinAt' | 'lastBalanceRefresh'>
  & Partial<Pick<AccountRow, 'balanceUsed' | 'lastCheckinAt' | 'lastBalanceRefresh'>>;

type BackupRouteChannelRow = Omit<RouteChannelRow,
  'successCount'
  | 'failCount'
  | 'totalLatencyMs'
  | 'totalCost'
  | 'lastUsedAt'
  | 'lastSelectedAt'
  | 'lastFailAt'
  | 'consecutiveFailCount'
  | 'cooldownLevel'
  | 'cooldownUntil'
> & Partial<Pick<RouteChannelRow,
  'successCount'
  | 'failCount'
  | 'totalLatencyMs'
  | 'totalCost'
  | 'lastUsedAt'
  | 'lastSelectedAt'
  | 'lastFailAt'
  | 'consecutiveFailCount'
  | 'cooldownLevel'
  | 'cooldownUntil'
>>;

type BackupSiteDisabledModelRow = Pick<SiteDisabledModelRow, 'siteId' | 'modelName'>;
type BackupManualModelRow = {
  accountId: number;
  modelName: string;
};
type BackupDownstreamApiKeyRow = Pick<DownstreamApiKeyRow,
  'name'
  | 'key'
  | 'description'
  | 'groupName'
  | 'tags'
  | 'enabled'
  | 'expiresAt'
  | 'maxCost'
  | 'maxRequests'
  | 'supportedModels'
  | 'allowedRouteIds'
  | 'siteWeightMultipliers'
  | 'excludedSiteIds'
  | 'excludedCredentialRefs'
> & Partial<Pick<DownstreamApiKeyRow, 'usedCost' | 'usedRequests' | 'lastUsedAt'>>;

interface AccountsBackupSection {
  sites: SiteRow[];
  siteApiEndpoints?: SiteApiEndpointRow[];
  accounts: BackupAccountRow[];
  accountTokens: AccountTokenRow[];
  tokenRoutes: TokenRouteRow[];
  routeChannels: BackupRouteChannelRow[];
  routeGroupSources: RouteGroupSourceRow[];
  siteDisabledModels?: BackupSiteDisabledModelRow[];
  manualModels?: BackupManualModelRow[];
  downstreamApiKeys?: BackupDownstreamApiKeyRow[];
}

interface PreferencesBackupSection {
  settings: Array<{ key: string; value: unknown }>;
}

interface BackupFullV2 {
  version: string;
  timestamp: number;
  accounts: AccountsBackupSection;
  preferences: PreferencesBackupSection;
}

interface BackupAccountsPartialV2 {
  version: string;
  timestamp: number;
  type: 'accounts';
  accounts: AccountsBackupSection;
}

interface BackupPreferencesPartialV2 {
  version: string;
  timestamp: number;
  type: 'preferences';
  preferences: PreferencesBackupSection;
}

type BackupV2 = BackupFullV2 | BackupAccountsPartialV2 | BackupPreferencesPartialV2;

type RawBackupData = Record<string, unknown>;

type AccountRuntimeSnapshot = {
  balanceUsed: number | null;
  lastCheckinAt: string | null;
  lastBalanceRefresh: string | null;
};

type RouteChannelRuntimeSnapshot = Pick<RouteChannelRow,
  'successCount'
  | 'failCount'
  | 'totalLatencyMs'
  | 'totalCost'
  | 'lastUsedAt'
  | 'lastSelectedAt'
  | 'lastFailAt'
  | 'consecutiveFailCount'
  | 'cooldownLevel'
  | 'cooldownUntil'
>;

type ProxyLogSnapshot = ProxyLogRow & {
  accountKey: string | null;
  routeKey: string | null;
  channelKey: string | null;
  downstreamApiKeyKey: string | null;
};

type CheckinLogSnapshot = CheckinLogRow & {
  accountKey: string | null;
};

type SiteAnnouncementSnapshot = SiteAnnouncementRow & {
  siteKey: string | null;
};

type ModelAvailabilitySnapshot = ModelAvailabilityRow & {
  accountKey: string | null;
};

type TokenModelAvailabilitySnapshot = TokenModelAvailabilityRow & {
  tokenKey: string | null;
};

type DownstreamApiKeyRuntimeSnapshot = Pick<DownstreamApiKeyRow, 'usedCost' | 'usedRequests' | 'lastUsedAt'>;

interface RuntimeIdentityIndexes {
  siteKeyById: Map<number, string>;
  siteIdByKey: Map<string, number>;
  accountKeyById: Map<number, string>;
  accountIdByKey: Map<string, number>;
  tokenKeyById: Map<number, string>;
  tokenIdByKey: Map<string, number>;
  routeKeyById: Map<number, string>;
  routeIdByKey: Map<string, number>;
  channelKeyById: Map<number, string>;
  channelIdByKey: Map<string, number>;
}

interface RuntimeStateSnapshot {
  accountRuntimeByKey: Map<string, AccountRuntimeSnapshot>;
  routeChannelRuntimeByKey: Map<string, RouteChannelRuntimeSnapshot>;
  siteAnnouncements: SiteAnnouncementSnapshot[];
  nonManualAvailability: ModelAvailabilitySnapshot[];
  tokenAvailability: TokenModelAvailabilitySnapshot[];
  downstreamApiKeyRuntimeByKey: Map<string, DownstreamApiKeyRuntimeSnapshot>;
  downstreamApiKeyIdByKey: Map<string, number>;
  proxyLogs: ProxyLogSnapshot[];
  checkinLogs: CheckinLogSnapshot[];
}

interface BackupImportResult {
  allImported: boolean;
  sections: {
    accounts: boolean;
    preferences: boolean;
  };
  appliedSettings: Array<{ key: string; value: unknown }>;
  summary?: {
    importedSites: number;
    importedAccounts: number;
    importedProfiles: number;
    importedApiKeyConnections: number;
    skippedAccounts: number;
    ignoredSections: string[];
    // 新增统计参数
    newSites: number;
    updatedSites: number;
    newAccounts: number;
    updatedAccounts: number;
    newTokens: number;
    updatedTokens: number;
    newSettings: number;
    updatedSettings: number;
  };
  warnings?: string[];
  errors?: string[];
}

const EXCLUDED_SETTING_KEYS = new Set<string>([
  // Keep current admin login credential unchanged to avoid accidental lock-out.
  'auth_token',
  // Runtime database selection is environment-bound and must not be propagated by backups.
  'db_type',
  'db_url',
  'db_ssl',
]);
const BACKUP_WEBDAV_CONFIG_SETTING_KEY = 'backup_webdav_config_v1';
const BACKUP_WEBDAV_STATE_SETTING_KEY = 'backup_webdav_state_v1';
const BACKUP_WEBDAV_DEFAULT_AUTO_SYNC_CRON = '0 */6 * * *';
const BACKUP_WEBDAV_FETCH_TIMEOUT_MS = 300_000;
let backupWebdavTask: cron.ScheduledTask | null = null;

const DIRECT_API_PLATFORMS = new Set([
  'openai',
  'claude',
  'gemini',
  'cliproxyapi',
  'codex',
  'gemini-cli',
  'antigravity',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toIsoString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function normalizeLegacyQuota(raw: unknown): number {
  const value = asNumber(raw, 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // ref-all-api-hub stores quota in raw units for NewAPI-like sites.
  // Convert obvious raw values to display currency units.
  if (value >= 10_000) return value / 500_000;
  return value;
}

function resolveImportedOauthColumns(row: Pick<AccountRow, 'oauthProvider' | 'oauthAccountKey' | 'oauthProjectId' | 'extraConfig'>) {
  const oauth = getOauthInfoFromAccount(row);
  const oauthProvider = row.oauthProvider || oauth?.provider || null;
  const oauthAccountKey = row.oauthAccountKey || oauth?.accountKey || oauth?.accountId || null;
  const oauthProjectId = row.oauthProjectId || oauth?.projectId || null;
  return {
    oauthProvider,
    oauthAccountKey,
    oauthProjectId,
  };
}

function buildSiteIdentityKey(row: Pick<SiteRow, 'platform' | 'url'>): string {
  return `${asString(row.platform).toLowerCase()}::${normalizeOriginUrl(asString(row.url))}`;
}

function buildAccountIdentityKey(input: {
  siteKey: string;
  username?: string | null;
  accessToken?: string | null;
  apiToken?: string | null;
  oauthProvider?: string | null;
  oauthAccountKey?: string | null;
  oauthProjectId?: string | null;
}): string {
  const oauthProvider = asString(input.oauthProvider).toLowerCase();
  const oauthAccountKey = asString(input.oauthAccountKey);
  const oauthProjectId = asString(input.oauthProjectId);
  if (oauthProvider || oauthAccountKey || oauthProjectId) {
    return `oauth::${input.siteKey}::${oauthProvider}::${oauthAccountKey}::${oauthProjectId}`;
  }

  const apiToken = asString(input.apiToken);
  if (apiToken) {
    return `api::${input.siteKey}::${apiToken}`;
  }

  const accessToken = asString(input.accessToken);
  if (accessToken) {
    return `session::${input.siteKey}::${accessToken}`;
  }

  return `user::${input.siteKey}::${asString(input.username)}`;
}

function buildTokenIdentityKey(row: Pick<AccountTokenRow, 'name' | 'token' | 'tokenGroup' | 'source' | 'isDefault'>, accountKey: string): string {
  const token = asString(row.token);
  if (token) {
    return `token::${accountKey}::${token}`;
  }

  return [
    'token-meta',
    accountKey,
    asString(row.name),
    asString(row.tokenGroup),
    asString(row.source),
    row.isDefault ? '1' : '0',
  ].join('::');
}

function buildRouteIdentityKey(row: Pick<TokenRouteRow, 'modelPattern' | 'routeMode'>): string {
  return [
    asString(row.modelPattern),
    asString(row.routeMode),
  ].join('::');
}

function buildModelAvailabilityIdentityKey(accountKey: string, modelName: string): string {
  return [accountKey, asString(modelName)].join('::');
}

function buildRouteChannelIdentityKey(
  row: Pick<RouteChannelRow, 'routeId' | 'accountId' | 'tokenId' | 'sourceModel'>,
  indexes: Pick<RuntimeIdentityIndexes, 'accountKeyById' | 'tokenKeyById' | 'routeKeyById'>,
): string | null {
  const routeKey = indexes.routeKeyById.get(row.routeId);
  const accountKey = indexes.accountKeyById.get(row.accountId);
  if (!routeKey || !accountKey) return null;

  const tokenKey = row.tokenId ? (indexes.tokenKeyById.get(row.tokenId) || '') : '';
  return [routeKey, accountKey, tokenKey, asString(row.sourceModel)].join('::');
}

function buildRuntimeIdentityIndexesFromSection(section: AccountsBackupSection): RuntimeIdentityIndexes {
  const siteKeyById = new Map<number, string>();
  const siteIdByKey = new Map<string, number>();
  const accountKeyById = new Map<number, string>();
  const accountIdByKey = new Map<string, number>();
  const tokenKeyById = new Map<number, string>();
  const tokenIdByKey = new Map<string, number>();
  const routeKeyById = new Map<number, string>();
  const routeIdByKey = new Map<string, number>();
  const channelKeyById = new Map<number, string>();
  const channelIdByKey = new Map<string, number>();

  for (const row of section.sites) {
    const siteKey = buildSiteIdentityKey(row);
    siteKeyById.set(row.id, siteKey);
    siteIdByKey.set(siteKey, row.id);
  }

  for (const row of section.accounts) {
    const siteKey = siteKeyById.get(row.siteId);
    if (!siteKey) continue;
    const oauthColumns = resolveImportedOauthColumns(row);
    const accountKey = buildAccountIdentityKey({
      siteKey,
      username: row.username,
      accessToken: row.accessToken,
      apiToken: row.apiToken,
      oauthProvider: oauthColumns.oauthProvider,
      oauthAccountKey: oauthColumns.oauthAccountKey,
      oauthProjectId: oauthColumns.oauthProjectId,
    });
    accountKeyById.set(row.id, accountKey);
    accountIdByKey.set(accountKey, row.id);
  }

  for (const row of section.accountTokens) {
    const accountKey = accountKeyById.get(row.accountId);
    if (!accountKey) continue;
    const tokenKey = buildTokenIdentityKey(row, accountKey);
    tokenKeyById.set(row.id, tokenKey);
    tokenIdByKey.set(tokenKey, row.id);
  }

  for (const row of section.tokenRoutes) {
    const routeKey = buildRouteIdentityKey(row);
    routeKeyById.set(row.id, routeKey);
    routeIdByKey.set(routeKey, row.id);
  }

  for (const row of section.routeChannels) {
    const channelKey = buildRouteChannelIdentityKey(row, {
      accountKeyById,
      tokenKeyById,
      routeKeyById,
    });
    if (!channelKey) continue;
    channelKeyById.set(row.id, channelKey);
    channelIdByKey.set(channelKey, row.id);
  }

  return {
    siteKeyById,
    siteIdByKey,
    accountKeyById,
    accountIdByKey,
    tokenKeyById,
    tokenIdByKey,
    routeKeyById,
    routeIdByKey,
    channelKeyById,
    channelIdByKey,
  };
}

async function collectCurrentRuntimeStateSnapshot(): Promise<RuntimeStateSnapshot> {
  const startTime = Date.now();
  console.log('[backup] Starting collectCurrentRuntimeStateSnapshot');
  
  const [
    sites,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
    siteAnnouncements,
    modelAvailability,
    tokenModelAvailability,
    downstreamApiKeys,
  ] = await Promise.all([
    db.select().from(schema.sites).all(),
    db.select().from(schema.accounts).all(),
    db.select().from(schema.accountTokens).all(),
    db.select().from(schema.tokenRoutes).all(),
    db.select().from(schema.routeChannels).all(),
    db.select().from(schema.siteAnnouncements).all(),
    db.select().from(schema.modelAvailability).all(),
    db.select().from(schema.tokenModelAvailability).all(),
    db.select().from(schema.downstreamApiKeys).all(),
  ]);
  
  console.log('[backup] Basic data queries completed in', Date.now() - startTime, 'ms');
  
  const proxyLogsStartTime = Date.now();
  const proxyLogs = await batchQueryAll(schema.proxyLogs, db, LOGS_BATCH_SIZE);
  console.log('[backup] proxyLogs query completed in', Date.now() - proxyLogsStartTime, 'ms, count:', proxyLogs.length);
  
  const checkinLogsStartTime = Date.now();
  const checkinLogs = await batchQueryAll(schema.checkinLogs, db, LOGS_BATCH_SIZE);
  console.log('[backup] checkinLogs query completed in', Date.now() - checkinLogsStartTime, 'ms, count:', checkinLogs.length);
  
  console.log('[backup] collectCurrentRuntimeStateSnapshot completed in', Date.now() - startTime, 'ms');

  const siteKeyById = new Map<number, string>();
  for (const row of sites) {
    siteKeyById.set(row.id, buildSiteIdentityKey(row));
  }

  const accountKeyById = new Map<number, string>();
  const accountRuntimeByKey = new Map<string, AccountRuntimeSnapshot>();
  for (const row of accounts) {
    const siteKey = siteKeyById.get(row.siteId);
    if (!siteKey) continue;
    const oauthColumns = resolveImportedOauthColumns(row);
    const accountKey = buildAccountIdentityKey({
      siteKey,
      username: row.username,
      accessToken: row.accessToken,
      apiToken: row.apiToken,
      oauthProvider: oauthColumns.oauthProvider,
      oauthAccountKey: oauthColumns.oauthAccountKey,
      oauthProjectId: oauthColumns.oauthProjectId,
    });
    accountKeyById.set(row.id, accountKey);
    accountRuntimeByKey.set(accountKey, {
      balanceUsed: row.balanceUsed ?? 0,
      lastCheckinAt: row.lastCheckinAt ?? null,
      lastBalanceRefresh: row.lastBalanceRefresh ?? null,
    });
  }

  const tokenKeyById = new Map<number, string>();
  for (const row of accountTokens) {
    const accountKey = accountKeyById.get(row.accountId);
    if (!accountKey) continue;
    tokenKeyById.set(row.id, buildTokenIdentityKey(row, accountKey));
  }

  const routeKeyById = new Map<number, string>();
  for (const row of tokenRoutes) {
    routeKeyById.set(row.id, buildRouteIdentityKey(row));
  }

  const channelKeyById = new Map<number, string>();
  const routeChannelRuntimeByKey = new Map<string, RouteChannelRuntimeSnapshot>();
  for (const row of routeChannels) {
    const channelKey = buildRouteChannelIdentityKey(row, {
      accountKeyById,
      tokenKeyById,
      routeKeyById,
    });
    if (!channelKey) continue;
    channelKeyById.set(row.id, channelKey);
    routeChannelRuntimeByKey.set(channelKey, {
      successCount: row.successCount,
      failCount: row.failCount,
      totalLatencyMs: row.totalLatencyMs,
      totalCost: row.totalCost,
      lastUsedAt: row.lastUsedAt ?? null,
      lastSelectedAt: row.lastSelectedAt ?? null,
      lastFailAt: row.lastFailAt ?? null,
      consecutiveFailCount: row.consecutiveFailCount ?? 0,
      cooldownLevel: row.cooldownLevel ?? 0,
      cooldownUntil: row.cooldownUntil ?? null,
    });
  }

  const downstreamApiKeyKeyById = new Map<number, string>();
  const downstreamApiKeyIdByKey = new Map<string, number>();
  const downstreamApiKeyRuntimeByKey = new Map<string, DownstreamApiKeyRuntimeSnapshot>();
  for (const row of downstreamApiKeys) {
    const key = asString(row.key);
    if (!key) continue;
    downstreamApiKeyKeyById.set(row.id, key);
    downstreamApiKeyIdByKey.set(key, row.id);
    downstreamApiKeyRuntimeByKey.set(key, {
      usedCost: row.usedCost ?? 0,
      usedRequests: row.usedRequests ?? 0,
      lastUsedAt: row.lastUsedAt ?? null,
    });
  }

  return {
    accountRuntimeByKey,
    routeChannelRuntimeByKey,
    siteAnnouncements: siteAnnouncements.map((row) => ({
      ...row,
      siteKey: siteKeyById.get(row.siteId) || null,
    })),
    nonManualAvailability: modelAvailability
      .filter((row) => !row.isManual)
      .map((row) => ({
        ...row,
        accountKey: accountKeyById.get(row.accountId) || null,
      })),
    tokenAvailability: tokenModelAvailability.map((row) => ({
      ...row,
      tokenKey: tokenKeyById.get(row.tokenId) || null,
    })),
    downstreamApiKeyRuntimeByKey,
    downstreamApiKeyIdByKey,
    proxyLogs: proxyLogs.map((row) => ({
      ...row,
      accountKey: row.accountId ? (accountKeyById.get(row.accountId) || null) : null,
      routeKey: row.routeId ? (routeKeyById.get(row.routeId) || null) : null,
      channelKey: row.channelId ? (channelKeyById.get(row.channelId) || null) : null,
      downstreamApiKeyKey: row.downstreamApiKeyId ? (downstreamApiKeyKeyById.get(row.downstreamApiKeyId) || null) : null,
    })),
    checkinLogs: checkinLogs.map((row) => ({
      ...row,
      accountKey: accountKeyById.get(row.accountId) || null,
    })),
  };
}

function normalizeLegacyPlatform(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return 'new-api';

  const supported = new Set([
    'new-api',
    'one-api',
    'anyrouter',
    'one-hub',
    'done-hub',
    'sub2api',
    'veloera',
  ]);
  if (supported.has(value)) return value;

  if (value.includes('wong')) return 'new-api';
  if (value.includes('anyrouter')) return 'anyrouter';
  if (value.includes('done')) return 'done-hub';

  return 'new-api';
}

function normalizeOriginUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function resolveImportedPlatform(rawPlatform: unknown, rawUrl: string): string {
  const rawPlatformText = asString(rawPlatform).toLowerCase();
  const normalizedPlatform = rawPlatformText
    ? (
      Object.prototype.hasOwnProperty.call(PLATFORM_ALIASES, rawPlatformText)
        ? PLATFORM_ALIASES[rawPlatformText]
        : (DIRECT_API_PLATFORMS.has(rawPlatformText) ? rawPlatformText : '')
    )
    : '';
  if (normalizedPlatform) return normalizedPlatform;

  const urlHint = detectPlatformByUrlHint(rawUrl);
  if (urlHint) return urlHint;

  return normalizeLegacyPlatform(asString(rawPlatform));
}

function resolveImportedProfilePlatform(apiType: unknown, baseUrl: string): string {
  const normalizedType = asString(apiType).toLowerCase();
  if (normalizedType === 'openai') return 'openai';
  if (normalizedType === 'anthropic') return 'claude';
  if (normalizedType === 'google') return 'gemini';
  if (normalizedType === 'openai-compatible') {
    return detectPlatformByUrlHint(baseUrl) || 'openai';
  }
  return detectPlatformByUrlHint(baseUrl) || 'openai';
}

function pushDefaultImportedToken(
  rows: AccountTokenRow[],
  nextId: () => number,
  accountId: number,
  token: string | null,
  createdAt: string,
  updatedAt: string,
) {
  if (!token) return;
  rows.push({
    id: nextId(),
    accountId,
    name: 'default',
    token,
    tokenGroup: 'default',
    valueStatus: 'ready',
    source: 'legacy',
    enabled: true,
    isDefault: true,
    createdAt,
    updatedAt,
  });
}

function buildAllApiHubV2AccountsSection(data: RawBackupData): {
  section: AccountsBackupSection;
  summary: NonNullable<BackupImportResult['summary']>;
  warnings: string[];
} | null {
  const accountsContainer = isRecord(data.accounts) ? data.accounts : null;
  if (!accountsContainer || !Array.isArray(accountsContainer.accounts)) return null;

  if (coerceAccountsSection(accountsContainer)) return null;

  const looksLikeLegacyAccountRow = accountsContainer.accounts.some((row) => (
    isRecord(row) && (
      Object.prototype.hasOwnProperty.call(row, 'site_url')
      || Object.prototype.hasOwnProperty.call(row, 'site_type')
      || Object.prototype.hasOwnProperty.call(row, 'account_info')
      || Object.prototype.hasOwnProperty.call(row, 'cookieAuth')
      || Object.prototype.hasOwnProperty.call(row, 'authType')
      || Object.prototype.hasOwnProperty.call(row, 'sub2apiAuth')
    )
  ));

  const looksLikeV2 =
    looksLikeLegacyAccountRow
    && (
      (typeof data.version === 'string' && data.version.startsWith('2'))
      || Object.prototype.hasOwnProperty.call(accountsContainer, 'last_updated')
      || Array.isArray(accountsContainer.bookmarks)
      || Array.isArray(accountsContainer.pinnedAccountIds)
      || Array.isArray(accountsContainer.orderedAccountIds)
      || (isRecord(data.apiCredentialProfiles) && Array.isArray(data.apiCredentialProfiles.profiles))
    );

  if (!looksLikeV2) return null;

  const section: AccountsBackupSection = {
    sites: [],
    accounts: [],
    accountTokens: [],
    tokenRoutes: [],
    routeChannels: [],
    routeGroupSources: [],
  };
  const siteIdByKey = new Map<string, number>();
  let nextSiteId = 1;
  let nextAccountId = 1;
  let nextTokenId = 1;
  const warnings: string[] = [];
  const ignoredSections: string[] = [];
  let importedAccounts = 0;
  let importedProfiles = 0;
  let importedApiKeyConnections = 0;
  let skippedAccounts = 0;

  const nextToken = () => nextTokenId++;
  const ensureSite = (input: {
    platform: string;
    url: string;
    name?: string;
    createdAt: string;
    updatedAt: string;
  }) => {
    const normalizedUrl = normalizeOriginUrl(input.url);
    if (!normalizedUrl) return null;
    const key = `${input.platform}::${normalizedUrl}`;
    const existingId = siteIdByKey.get(key);
    if (existingId) return existingId;

    const siteId = nextSiteId++;
    siteIdByKey.set(key, siteId);
    section.sites.push({
      id: siteId,
      name: asString(input.name) || normalizedUrl,
      url: normalizedUrl,
      externalCheckinUrl: null,
      platform: input.platform,
      proxyUrl: null,
      useSystemProxy: false,
      customHeaders: null,
      status: 'active',
      isPinned: false,
      sortOrder: section.sites.length,
      globalWeight: 1,
      apiKey: null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
    return siteId;
  };

  const addIgnoredSection = (name: string, active: boolean) => {
    if (active && !ignoredSections.includes(name)) ignoredSections.push(name);
  };

  addIgnoredSection('accounts.bookmarks', Array.isArray(accountsContainer.bookmarks) && accountsContainer.bookmarks.length > 0);
  addIgnoredSection('channelConfigs', isRecord(data.channelConfigs));
  addIgnoredSection('tagStore', isRecord(data.tagStore));

  for (const row of accountsContainer.accounts) {
    if (!isRecord(row)) continue;

    const createdAt = toIsoString(row.created_at);
    const updatedAt = toIsoString(row.updated_at);
    const siteUrl = normalizeOriginUrl(asString(row.site_url));
    const siteName = asString(row.site_name) || siteUrl;
    const platform = resolveImportedPlatform(row.site_type, siteUrl);
    const authType = asString(row.authType).toLowerCase();
    const accountInfo = isRecord(row.account_info) ? row.account_info : {};
    const cookieAuth = isRecord(row.cookieAuth) ? row.cookieAuth : {};
    const sub2apiAuth = isRecord(row.sub2apiAuth) ? row.sub2apiAuth : {};
    const rawAccountId = asString(row.id) || asString(row.username) || siteName || `account-${nextAccountId}`;
    const username = asString(accountInfo.username) || asString(row.username) || rawAccountId;
    const platformUserId = asNumber(accountInfo.id, 0);
    const checkin = isRecord(row.checkIn) ? row.checkIn : {};
    const accessTokenCandidate = asString(accountInfo.access_token) || asString(row.access_token);
    const cookieSession = asString(cookieAuth.sessionCookie);
    const isDirectApiPlatform = DIRECT_API_PLATFORMS.has(platform);

    let accessToken = '';
    let apiToken: string | null = null;
    let credentialMode: 'session' | 'apikey' | null = null;

    if (authType === 'cookie') {
      if (!cookieSession) {
        skippedAccounts += 1;
        warnings.push(`跳过 ALL-API-Hub 账号 ${rawAccountId}：cookieAuth.sessionCookie 缺失`);
        continue;
      }
      accessToken = cookieSession;
      credentialMode = 'session';
    } else if (authType === 'access_token') {
      if (!accessTokenCandidate) {
        skippedAccounts += 1;
        warnings.push(`跳过 ALL-API-Hub 账号 ${rawAccountId}：access_token 缺失`);
        continue;
      }
      if (isDirectApiPlatform) {
        accessToken = '';
        apiToken = accessTokenCandidate;
        credentialMode = 'apikey';
      } else {
        accessToken = accessTokenCandidate;
        credentialMode = 'session';
      }
    } else {
      skippedAccounts += 1;
      warnings.push(`跳过 ALL-API-Hub 账号 ${rawAccountId}：authType=${authType || 'unknown'} 不支持离线迁移`);
      continue;
    }

    const siteId = ensureSite({
      platform,
      url: siteUrl,
      name: siteName,
      createdAt,
      updatedAt,
    });
    if (!siteId) {
      skippedAccounts += 1;
      warnings.push(`跳过 ALL-API-Hub 账号 ${rawAccountId}：site_url 无效`);
      continue;
    }

    const importedBalance = normalizeLegacyQuota(accountInfo.quota);
    const importedUsed = normalizeLegacyQuota(accountInfo.today_quota_consumption);
    const importedQuota = importedBalance + importedUsed;
    const extraConfigPatch: Record<string, unknown> = {
      credentialMode,
      source: 'all-api-hub',
    };
    if (platformUserId > 0) {
      extraConfigPatch.platformUserId = platformUserId;
    }
    const refreshToken = asString(sub2apiAuth.refreshToken);
    const tokenExpiresAt = asNumber(sub2apiAuth.tokenExpiresAt, 0);
    if (refreshToken) {
      extraConfigPatch.sub2apiAuth = tokenExpiresAt > 0
        ? { refreshToken, tokenExpiresAt }
        : { refreshToken };
    }

    const accountId = nextAccountId++;
    section.accounts.push({
      id: accountId,
      siteId,
      username,
      accessToken,
      apiToken,
      oauthProvider: null,
      oauthAccountKey: null,
      oauthProjectId: null,
      balance: importedBalance,
      balanceUsed: importedUsed,
      quota: importedQuota > 0 ? importedQuota : importedBalance,
      unitCost: null,
      valueScore: 0,
      status: asBoolean(row.disabled, false) ? 'disabled' : 'active',
      isPinned: false,
      sortOrder: section.accounts.length,
      checkinEnabled: credentialMode === 'session' ? asBoolean(checkin.autoCheckInEnabled, true) : false,
      lastCheckinAt: null,
      lastBalanceRefresh: null,
      extraConfig: mergeAccountExtraConfig(undefined, extraConfigPatch),
      createdAt,
      updatedAt,
    });
    pushDefaultImportedToken(section.accountTokens, nextToken, accountId, apiToken, createdAt, updatedAt);
    if (credentialMode === 'apikey') importedApiKeyConnections += 1;
    importedAccounts += 1;
  }

  const profilesContainer = isRecord(data.apiCredentialProfiles) ? data.apiCredentialProfiles : null;
  const profiles = Array.isArray(profilesContainer?.profiles) ? profilesContainer.profiles : [];
  for (const profile of profiles) {
    if (!isRecord(profile)) continue;

    const baseUrl = normalizeOriginUrl(asString(profile.baseUrl));
    const apiKey = asString(profile.apiKey);
    if (!baseUrl || !apiKey) {
      warnings.push(`跳过 ALL-API-Hub API 凭据 ${asString(profile.id) || asString(profile.name) || 'unknown'}：baseUrl 或 apiKey 缺失`);
      continue;
    }

    const createdAt = toIsoString(profile.createdAt);
    const updatedAt = toIsoString(profile.updatedAt);
    const platform = resolveImportedProfilePlatform(profile.apiType, asString(profile.baseUrl));
    const siteId = ensureSite({
      platform,
      url: baseUrl,
      name: baseUrl,
      createdAt,
      updatedAt,
    });
    if (!siteId) continue;

    const accountId = nextAccountId++;
    section.accounts.push({
      id: accountId,
      siteId,
      username: asString(profile.name) || asString(profile.id) || baseUrl,
      accessToken: '',
      apiToken: apiKey,
      oauthProvider: null,
      oauthAccountKey: null,
      oauthProjectId: null,
      balance: 0,
      balanceUsed: 0,
      quota: 0,
      unitCost: null,
      valueScore: 0,
      status: 'active',
      isPinned: false,
      sortOrder: section.accounts.length,
      checkinEnabled: false,
      lastCheckinAt: null,
      lastBalanceRefresh: null,
      extraConfig: mergeAccountExtraConfig(undefined, {
        credentialMode: 'apikey',
        source: 'all-api-hub-profile',
        importedProfileId: asString(profile.id) || undefined,
      }),
      createdAt,
      updatedAt,
    });
    pushDefaultImportedToken(section.accountTokens, nextToken, accountId, apiKey, createdAt, updatedAt);
    importedApiKeyConnections += 1;
    importedProfiles += 1;
  }

  return {
    section,
    summary: {
      importedSites: section.sites.length,
      importedAccounts,
      importedProfiles,
      importedApiKeyConnections,
      skippedAccounts,
      ignoredSections,
      newSites: section.sites.length,
      updatedSites: 0,
      newAccounts: importedAccounts,
      updatedAccounts: 0,
      newTokens: section.accountTokens.length,
      updatedTokens: 0,
      newSettings: 0,
      updatedSettings: 0,
    },
    warnings,
  };
}

function buildAccountsSectionFromRefBackup(data: RawBackupData): AccountsBackupSection | null {
  const accountsContainer = isRecord(data.accounts) ? data.accounts : null;
  const rows = Array.isArray(accountsContainer?.accounts) ? accountsContainer.accounts : null;
  if (!rows) return null;

  const sites: SiteRow[] = [];
  const accounts: AccountRow[] = [];
  const accountTokens: AccountTokenRow[] = [];
  const tokenRoutes: TokenRouteRow[] = [];
  const routeChannels: RouteChannelRow[] = [];

  const siteIdByKey = new Map<string, number>();
  let nextSiteId = 1;
  let nextAccountId = 1;
  let nextTokenId = 1;

  for (const item of rows) {
    if (!isRecord(item)) continue;

    const siteUrl = asString(item.site_url);
    if (!siteUrl) continue;

    const platform = normalizeLegacyPlatform(asString(item.site_type));
    const siteName = asString(item.site_name) || siteUrl;
    const siteKey = `${platform}::${siteUrl}`;

    let siteId = siteIdByKey.get(siteKey) || 0;
    if (!siteId) {
      siteId = nextSiteId++;
      siteIdByKey.set(siteKey, siteId);
      sites.push({
        id: siteId,
        name: siteName,
        url: siteUrl,
        externalCheckinUrl: null,
        platform,
        proxyUrl: null,
        useSystemProxy: false,
        customHeaders: null,
        status: 'active',
        isPinned: false,
        sortOrder: sites.length,
        globalWeight: 1,
        apiKey: null,
        createdAt: toIsoString(item.created_at),
        updatedAt: toIsoString(item.updated_at),
      });
    }

    const accountInfo = isRecord(item.account_info) ? item.account_info : {};
    const cookieAuth = isRecord(item.cookieAuth) ? item.cookieAuth : {};
    const authType = asString(item.authType);

    const accountAccessToken =
      asString(accountInfo.access_token)
      || asString(cookieAuth.sessionCookie)
      || asString((item as Record<string, unknown>).access_token);
    if (!accountAccessToken) continue;

    const platformUserId = asNumber(accountInfo.id, 0);
    const username = asString(accountInfo.username)
      || asString(item.username)
      || (platformUserId > 0 ? `user-${platformUserId}` : `account-${nextAccountId}`);

    let apiToken: string | null = null;
    if (authType === 'api_key') {
      apiToken = accountAccessToken;
    }

    const createdAt = toIsoString(item.created_at);
    const updatedAt = toIsoString(item.updated_at);
    const checkin = isRecord(item.checkIn) ? item.checkIn : {};
    const extraConfigPayload = {
      platformUserId: platformUserId > 0 ? platformUserId : undefined,
      authType: authType || undefined,
      source: 'ref-all-api-hub',
    };

    const accountId = nextAccountId++;
    const importedBalance = normalizeLegacyQuota(accountInfo.quota);
    const importedUsed = normalizeLegacyQuota(accountInfo.today_quota_consumption);
    const importedQuota = importedBalance + importedUsed;

    accounts.push({
      id: accountId,
      siteId,
      username,
      accessToken: accountAccessToken,
      apiToken,
      oauthProvider: null,
      oauthAccountKey: null,
      oauthProjectId: null,
      balance: importedBalance,
      balanceUsed: importedUsed,
      quota: importedQuota > 0 ? importedQuota : importedBalance,
      unitCost: null,
      valueScore: 0,
      status: asBoolean(item.disabled, false) ? 'disabled' : 'active',
      isPinned: false,
      sortOrder: accounts.length,
      checkinEnabled: asBoolean(checkin.autoCheckInEnabled, true),
      lastCheckinAt: null,
      lastBalanceRefresh: null,
      extraConfig: JSON.stringify(extraConfigPayload),
      createdAt,
      updatedAt,
    });

    if (apiToken) {
      accountTokens.push({
        id: nextTokenId++,
        accountId,
        name: 'default',
        token: apiToken,
        tokenGroup: 'default',
        valueStatus: 'ready',
        source: 'legacy',
        enabled: true,
        isDefault: true,
        createdAt,
        updatedAt,
      });
    }
  }

  return {
    sites,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
    routeGroupSources: [],
  };
}

function buildPreferencesSectionFromRefBackup(data: RawBackupData): PreferencesBackupSection | null {
  const settings: Array<{ key: string; value: unknown }> = [];

  if (isRecord(data.preferences)) {
    settings.push({ key: 'legacy_preferences_ref_v2', value: data.preferences });
  }
  if (isRecord(data.channelConfigs)) {
    settings.push({ key: 'legacy_channel_configs_ref_v2', value: data.channelConfigs });
  }
  if (isRecord(data.tagStore)) {
    settings.push({ key: 'legacy_tag_store_ref_v2', value: data.tagStore });
  }

  if (settings.length === 0) return null;
  return { settings };
}

function parseSettingValue(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stringifySettingValue(value: unknown): string {
  return JSON.stringify(value);
}

function isValidBackupExportType(value: unknown): value is BackupExportType {
  return value === 'all' || value === 'accounts' || value === 'preferences';
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function isValidHttpUrl(raw: string): boolean {
  if (!raw.trim()) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeBackupWebdavConfig(raw: unknown): BackupWebdavConfig {
  const source = isRecord(raw) ? raw : {};
  const exportType = isValidBackupExportType(source.exportType) ? source.exportType : 'all';
  const autoSyncCron = typeof source.autoSyncCron === 'string' && cron.validate(source.autoSyncCron)
    ? source.autoSyncCron
    : BACKUP_WEBDAV_DEFAULT_AUTO_SYNC_CRON;

  return {
    enabled: source.enabled === true,
    fileUrl: asString(source.fileUrl),
    username: asString(source.username),
    password: typeof source.password === 'string' ? source.password : '',
    exportType,
    autoSyncEnabled: source.autoSyncEnabled === true,
    autoSyncCron,
  };
}

function normalizeBackupWebdavState(raw: unknown): BackupWebdavState {
  const source = isRecord(raw) ? raw : {};
  return {
    lastSyncAt: typeof source.lastSyncAt === 'string' && source.lastSyncAt.trim() ? source.lastSyncAt : null,
    lastError: typeof source.lastError === 'string' && source.lastError.trim() ? source.lastError : null,
  };
}

function toBackupWebdavConfigView(config: BackupWebdavConfig): BackupWebdavConfigView {
  return {
    enabled: config.enabled,
    fileUrl: config.fileUrl,
    username: config.username,
    exportType: config.exportType,
    autoSyncEnabled: config.autoSyncEnabled,
    autoSyncCron: config.autoSyncCron,
    hasPassword: config.password.length > 0,
    passwordMasked: maskSecret(config.password),
  };
}

async function readSettingValue(key: string): Promise<unknown> {
  const row = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).get();
  return parseSettingValue(row?.value ?? null);
}

async function loadBackupWebdavConfig(): Promise<BackupWebdavConfig> {
  return normalizeBackupWebdavConfig(await readSettingValue(BACKUP_WEBDAV_CONFIG_SETTING_KEY));
}

async function loadBackupWebdavState(): Promise<BackupWebdavState> {
  return normalizeBackupWebdavState(await readSettingValue(BACKUP_WEBDAV_STATE_SETTING_KEY));
}

async function writeBackupWebdavState(next: BackupWebdavState) {
  await upsertSetting(BACKUP_WEBDAV_STATE_SETTING_KEY, next);
}

function resolveBackupWebdavAuthHeader(config: BackupWebdavConfig): string | null {
  if (!config.username && !config.password) return null;
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
}

function validateBackupWebdavConfig(config: BackupWebdavConfig) {
  if (config.enabled && !isValidHttpUrl(config.fileUrl)) {
    throw new Error('WebDAV 文件地址无效，请填写 http/https 文件 URL');
  }
  if (!isValidBackupExportType(config.exportType)) {
    throw new Error('WebDAV 导出类型无效，仅支持 all/accounts/preferences');
  }
  if (!cron.validate(config.autoSyncCron)) {
    throw new Error('WebDAV 自动同步 Cron 表达式无效');
  }
  if (config.autoSyncEnabled && !config.enabled) {
    throw new Error('启用自动同步前请先启用 WebDAV 备份');
  }
}

async function fetchBackupWebdav(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, BACKUP_WEBDAV_FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`WebDAV 请求超时（${Math.max(1, Math.round(BACKUP_WEBDAV_FETCH_TIMEOUT_MS / 1000))}s）`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

function stopBackupWebdavScheduler() {
  backupWebdavTask?.stop();
  backupWebdavTask = null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSettingValueAcceptable(key: string, value: unknown): boolean {
  if (key === 'checkin_cron' || key === 'balance_refresh_cron' || key === 'log_cleanup_cron') {
    return typeof value === 'string' && cron.validate(value);
  }

  if (key === 'log_cleanup_usage_logs_enabled' || key === 'log_cleanup_program_logs_enabled') {
    return typeof value === 'boolean';
  }

  if (key === 'log_cleanup_retention_days') {
    return isFiniteNumber(value) && value >= 1;
  }

  if (key === 'proxy_token') {
    return typeof value === 'string'
      && value.trim().length >= 6
      && value.trim().startsWith('sk-');
  }

  if (key === 'smtp_port') {
    return isFiniteNumber(value) && value > 0;
  }

  if (key === 'routing_weights') {
    if (!isRecord(value)) return false;
    const keys = ['baseWeightFactor', 'valueScoreFactor', 'costWeight', 'balanceWeight', 'usageWeight'] as const;
    return keys.every((weightKey) => value[weightKey] === undefined || isFiniteNumber(value[weightKey]));
  }

  return true;
}

async function exportAccountsSection(): Promise<AccountsBackupSection> {
  const [
    sites,
    siteApiEndpoints,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
    routeGroupSources,
    siteDisabledModels,
    manualModels,
    downstreamApiKeys,
  ] = await Promise.all([
    db.select().from(schema.sites).orderBy(asc(schema.sites.id)).all(),
    db.select().from(schema.siteApiEndpoints)
      .orderBy(
        asc(schema.siteApiEndpoints.siteId),
        asc(schema.siteApiEndpoints.sortOrder),
        asc(schema.siteApiEndpoints.id),
      )
      .all(),
    db.select().from(schema.accounts).orderBy(asc(schema.accounts.id)).all(),
    db.select().from(schema.accountTokens).orderBy(asc(schema.accountTokens.id)).all(),
    db.select().from(schema.tokenRoutes).orderBy(asc(schema.tokenRoutes.id)).all(),
    db.select().from(schema.routeChannels).orderBy(asc(schema.routeChannels.id)).all(),
    db.select().from(schema.routeGroupSources).orderBy(asc(schema.routeGroupSources.id)).all(),
    db.select().from(schema.siteDisabledModels)
      .orderBy(asc(schema.siteDisabledModels.siteId), asc(schema.siteDisabledModels.modelName))
      .all(),
    db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.isManual, true))
      .orderBy(asc(schema.modelAvailability.accountId), asc(schema.modelAvailability.modelName))
      .all(),
    db.select().from(schema.downstreamApiKeys).orderBy(asc(schema.downstreamApiKeys.id)).all(),
  ]);

  return {
    sites,
    siteApiEndpoints,
    accounts: accounts.map(({ balanceUsed: _balanceUsed, lastCheckinAt: _lastCheckinAt, lastBalanceRefresh: _lastBalanceRefresh, ...row }) => row),
    accountTokens,
    tokenRoutes,
    routeChannels: routeChannels.map(({
      successCount: _successCount,
      failCount: _failCount,
      totalLatencyMs: _totalLatencyMs,
      totalCost: _totalCost,
      lastUsedAt: _lastUsedAt,
      lastSelectedAt: _lastSelectedAt,
      lastFailAt: _lastFailAt,
      consecutiveFailCount: _consecutiveFailCount,
      cooldownLevel: _cooldownLevel,
      cooldownUntil: _cooldownUntil,
      ...row
    }) => row),
    routeGroupSources,
    siteDisabledModels: siteDisabledModels.map((row) => ({
      siteId: row.siteId,
      modelName: row.modelName,
    })),
    manualModels: manualModels.map((row) => ({
      accountId: row.accountId,
      modelName: row.modelName,
    })),
    downstreamApiKeys: downstreamApiKeys.map(({
      id: _id,
      usedCost: _usedCost,
      usedRequests: _usedRequests,
      lastUsedAt: _lastUsedAt,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...row
    }) => row),
  };
}

async function exportPreferencesSection(): Promise<PreferencesBackupSection> {
  const settings = (await db.select().from(schema.settings).all())
    .filter((row) => !EXCLUDED_SETTING_KEYS.has(row.key))
    .map((row) => ({
      key: row.key,
      value: parseSettingValue(row.value),
    }));

  return { settings };
}

export async function exportBackup(type: BackupExportType): Promise<BackupV2> {
  const now = Date.now();
  if (type === 'accounts') {
    return {
      version: BACKUP_VERSION,
      timestamp: now,
      type: 'accounts',
      accounts: await exportAccountsSection(),
    };
  }

  if (type === 'preferences') {
    return {
      version: BACKUP_VERSION,
      timestamp: now,
      type: 'preferences',
      preferences: await exportPreferencesSection(),
    };
  }

  return {
    version: BACKUP_VERSION,
    timestamp: now,
    accounts: await exportAccountsSection(),
    preferences: await exportPreferencesSection(),
  };
}

function coerceAccountsSection(input: unknown): AccountsBackupSection | null {
  if (!isRecord(input)) return null;

  const sites = Array.isArray(input.sites) ? input.sites as SiteRow[] : [];
  const siteApiEndpoints = Array.isArray(input.siteApiEndpoints)
    ? input.siteApiEndpoints as SiteApiEndpointRow[]
    : undefined;
  const accounts = Array.isArray(input.accounts) ? input.accounts as BackupAccountRow[] : [];
  const accountTokens = Array.isArray(input.accountTokens) ? input.accountTokens as AccountTokenRow[] : [];
  const tokenRoutes = Array.isArray(input.tokenRoutes) ? input.tokenRoutes as TokenRouteRow[] : [];
  const routeChannels = Array.isArray(input.routeChannels) ? input.routeChannels as BackupRouteChannelRow[] : [];
  const routeGroupSources = Array.isArray(input.routeGroupSources)
    ? input.routeGroupSources as RouteGroupSourceRow[]
    : [];
  const siteDisabledModels = Array.isArray(input.siteDisabledModels)
    ? input.siteDisabledModels as BackupSiteDisabledModelRow[]
    : undefined;
  const manualModels = Array.isArray(input.manualModels)
    ? input.manualModels as BackupManualModelRow[]
    : undefined;
  const downstreamApiKeys = Array.isArray(input.downstreamApiKeys)
    ? input.downstreamApiKeys as BackupDownstreamApiKeyRow[]
    : undefined;

  // 至少需要有sites或accounts数据
  if (sites.length === 0 && accounts.length === 0) return null;

  return {
    sites,
    siteApiEndpoints,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
    routeGroupSources,
    siteDisabledModels,
    manualModels,
    downstreamApiKeys,
  };
}

function coercePreferencesSection(input: unknown): PreferencesBackupSection | null {
  if (!isRecord(input)) return null;
  const settingsRaw = input.settings;
  
  let settings: Array<{ key: string; value: unknown }> = [];
  
  if (Array.isArray(settingsRaw)) {
    settings = settingsRaw
      .map((row) => {
        if (!isRecord(row)) return null;
        const key = typeof row.key === 'string' ? row.key.trim() : '';
        if (!key || EXCLUDED_SETTING_KEYS.has(key)) return null;
        return { key, value: row.value };
      })
      .filter((row): row is { key: string; value: unknown } => !!row);
  } else if (isRecord(settingsRaw)) {
    // 处理对象格式的设置
    settings = Object.entries(settingsRaw)
      .map(([key, value]) => {
        if (!key || EXCLUDED_SETTING_KEYS.has(key)) return null;
        return { key, value };
      })
      .filter((row): row is { key: string; value: unknown } => !!row);
  }

  // 即使settings为空，也返回一个有效的对象，这样设置部分就不会被标记为未导入
  return { settings };
}

function detectAccountsSection(data: RawBackupData): AccountsBackupSection | null {
  const rootMatch = coerceAccountsSection(data);
  if (rootMatch) return rootMatch;

  if ('accounts' in data) {
    const nested = coerceAccountsSection(data.accounts);
    if (nested) return nested;
  }

  if (isRecord(data.data) && 'accounts' in data.data) {
    const legacyNested = coerceAccountsSection((data.data as Record<string, unknown>).accounts);
    if (legacyNested) return legacyNested;
  }

  const allApiHubV2 = buildAllApiHubV2AccountsSection(data);
  if (allApiHubV2) return allApiHubV2.section;

  const refFormat = buildAccountsSectionFromRefBackup(data);
  if (refFormat) return refFormat;

  return null;
}

function detectPreferencesSection(data: RawBackupData): PreferencesBackupSection | null {
  const rootMatch = coercePreferencesSection(data);
  if (rootMatch) return rootMatch;

  if ('preferences' in data) {
    const nested = coercePreferencesSection(data.preferences);
    if (nested) return nested;
  }

  if (isRecord(data.data) && 'preferences' in data.data) {
    const legacyNested = coercePreferencesSection((data.data as Record<string, unknown>).preferences);
    if (legacyNested) return legacyNested;
  }

  const refFormat = buildPreferencesSectionFromRefBackup(data);
  if (refFormat) return refFormat;

  return null;
}

function detectImportMetadata(data: RawBackupData): {
  summary?: BackupImportResult['summary'];
  warnings?: string[];
} {
  const allApiHubV2 = buildAllApiHubV2AccountsSection(data);
  if (!allApiHubV2) return {};
  return {
    summary: allApiHubV2.summary,
    warnings: allApiHubV2.warnings.length > 0 ? allApiHubV2.warnings : undefined,
  };
}

async function importAccountsSection(section: AccountsBackupSection): Promise<{
  newSites: number;
  updatedSites: number;
  newAccounts: number;
  updatedAccounts: number;
  newTokens: number;
  updatedTokens: number;
}> {
  const startTime = Date.now();
  console.log('[backup] Starting importAccountsSection');
  
  const runtimeStateStartTime = Date.now();
  const runtimeState = await collectCurrentRuntimeStateSnapshot();
  console.log('[backup] collectCurrentRuntimeStateSnapshot completed in', Date.now() - runtimeStateStartTime, 'ms');
  
  const indexesStartTime = Date.now();
  const importedIndexes = buildRuntimeIdentityIndexesFromSection(section);
  console.log('[backup] buildRuntimeIdentityIndexesFromSection completed in', Date.now() - indexesStartTime, 'ms');
  
  // 初始化统计变量
  const stats = {
    newSites: 0,
    updatedSites: 0,
    newAccounts: 0,
    updatedAccounts: 0,
    newTokens: 0,
    updatedTokens: 0,
  };
  
  const shouldReplaceSiteDisabledModels = Array.isArray(section.siteDisabledModels);
  const shouldReplaceManualModels = Array.isArray(section.manualModels);
  const shouldReplaceDownstreamApiKeys = Array.isArray(section.downstreamApiKeys);

  // 第一步：获取现有数据的索引，用于智能对比
  console.log('[backup] Starting existing data indexing');
  const existingDataStartTime = Date.now();
  const existingSites = await db.select().from(schema.sites).all();
  const existingAccounts = await db.select().from(schema.accounts).all();
  const existingTokens = await db.select().from(schema.accountTokens).all();
  const existingRoutes = await db.select().from(schema.tokenRoutes).all();
  
  const existingSiteKeys = new Set(existingSites.map(site => buildSiteIdentityKey(site)));
  const existingAccountIds = new Set(existingAccounts.map(account => account.id));
  const existingTokenIds = new Set(existingTokens.map(token => token.id));
  const existingRouteIds = new Set(existingRoutes.map(route => route.id));
  console.log('[backup] Existing data indexing completed in', Date.now() - existingDataStartTime, 'ms');

  // 第二步：智能导入核心数据（使用单个事务提高效率）
  console.log('[backup] Starting smart core data import');
  const coreImportStartTime = Date.now();
  
  await db.transaction(async (tx) => {
    // 处理站点数据
    for (const site of section.sites) {
      const siteKey = buildSiteIdentityKey(site);
      const existingSite = existingSites.find(s => buildSiteIdentityKey(s) === siteKey);
      
      if (existingSite) {
        // 更新现有站点
        await tx.update(schema.sites).set({
          name: site.name,
          url: site.url,
          externalCheckinUrl: site.externalCheckinUrl ?? null,
          platform: site.platform,
          proxyUrl: site.proxyUrl ?? null,
          useSystemProxy: site.useSystemProxy ?? false,
          customHeaders: site.customHeaders ?? null,
          status: site.status || 'active',
          isPinned: site.isPinned ?? false,
          sortOrder: site.sortOrder ?? 0,
          globalWeight: site.globalWeight ?? 1,
          apiKey: site.apiKey,
          updatedAt: site.updatedAt,
        }).where(eq(schema.sites.id, existingSite.id)).run();
        stats.updatedSites++;
      } else {
        // 插入新站点
        await tx.insert(schema.sites).values({
          id: site.id,
          name: site.name,
          url: site.url,
          externalCheckinUrl: site.externalCheckinUrl ?? null,
          platform: site.platform,
          proxyUrl: site.proxyUrl ?? null,
          useSystemProxy: site.useSystemProxy ?? false,
          customHeaders: site.customHeaders ?? null,
          status: site.status || 'active',
          isPinned: site.isPinned ?? false,
          sortOrder: site.sortOrder ?? 0,
          globalWeight: site.globalWeight ?? 1,
          apiKey: site.apiKey,
          createdAt: site.createdAt,
          updatedAt: site.updatedAt,
        }).run();
        stats.newSites++;
      }
    }
    
    // 处理站点API端点
    if (section.siteApiEndpoints) {
      await batchInsertHelper(tx, schema.siteApiEndpoints, section.siteApiEndpoints.map((row) => ({
        id: row.id,
        siteId: row.siteId,
        url: row.url,
        enabled: row.enabled ?? true,
        sortOrder: row.sortOrder ?? 0,
        cooldownUntil: row.cooldownUntil ?? null,
        lastSelectedAt: row.lastSelectedAt ?? null,
        lastFailedAt: row.lastFailedAt ?? null,
        lastFailureReason: row.lastFailureReason ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })));
    }
    
    // 处理账号数据
    for (const row of section.accounts) {
      const oauthColumns = resolveImportedOauthColumns(row);
      const accountKey = importedIndexes.accountKeyById.get(row.id);
      const runtimeAccount = accountKey ? runtimeState.accountRuntimeByKey.get(accountKey) : undefined;
      
      if (existingAccountIds.has(row.id)) {
        // 更新现有账号
        await tx.update(schema.accounts).set({
          siteId: row.siteId,
          username: row.username,
          accessToken: row.accessToken,
          apiToken: row.apiToken,
          oauthProvider: oauthColumns.oauthProvider,
          oauthAccountKey: oauthColumns.oauthAccountKey,
          oauthProjectId: oauthColumns.oauthProjectId,
          balance: row.balance,
          balanceUsed: runtimeAccount?.balanceUsed ?? row.balanceUsed,
          quota: row.quota,
          unitCost: row.unitCost,
          valueScore: row.valueScore,
          status: row.status,
          isPinned: row.isPinned ?? false,
          sortOrder: row.sortOrder ?? 0,
          checkinEnabled: row.checkinEnabled,
          lastCheckinAt: runtimeAccount?.lastCheckinAt ?? row.lastCheckinAt,
          lastBalanceRefresh: runtimeAccount?.lastBalanceRefresh ?? row.lastBalanceRefresh,
          extraConfig: row.extraConfig,
          updatedAt: row.updatedAt,
        }).where(eq(schema.accounts.id, row.id)).run();
        stats.updatedAccounts++;
      } else {
        // 插入新账号
        await tx.insert(schema.accounts).values({
          id: row.id,
          siteId: row.siteId,
          username: row.username,
          accessToken: row.accessToken,
          apiToken: row.apiToken,
          oauthProvider: oauthColumns.oauthProvider,
          oauthAccountKey: oauthColumns.oauthAccountKey,
          oauthProjectId: oauthColumns.oauthProjectId,
          balance: row.balance,
          balanceUsed: runtimeAccount?.balanceUsed ?? row.balanceUsed,
          quota: row.quota,
          unitCost: row.unitCost,
          valueScore: row.valueScore,
          status: row.status,
          isPinned: row.isPinned ?? false,
          sortOrder: row.sortOrder ?? 0,
          checkinEnabled: row.checkinEnabled,
          lastCheckinAt: runtimeAccount?.lastCheckinAt ?? row.lastCheckinAt,
          lastBalanceRefresh: runtimeAccount?.lastBalanceRefresh ?? row.lastBalanceRefresh,
          extraConfig: row.extraConfig,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }).run();
        stats.newAccounts++;
      }
    }
    
    // 处理账号令牌
    for (const row of section.accountTokens) {
      if (existingTokenIds.has(row.id)) {
        // 更新现有令牌
        await tx.update(schema.accountTokens).set({
          accountId: row.accountId,
          name: row.name,
          token: row.token,
          tokenGroup: row.tokenGroup ?? null,
          valueStatus: row.valueStatus ?? 'ready',
          source: row.source,
          enabled: row.enabled,
          isDefault: row.isDefault,
          updatedAt: row.updatedAt,
        }).where(eq(schema.accountTokens.id, row.id)).run();
        stats.updatedTokens++;
      } else {
        // 插入新令牌
        await tx.insert(schema.accountTokens).values({
          id: row.id,
          accountId: row.accountId,
          name: row.name,
          token: row.token,
          tokenGroup: row.tokenGroup ?? null,
          valueStatus: row.valueStatus ?? 'ready',
          source: row.source,
          enabled: row.enabled,
          isDefault: row.isDefault,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }).run();
        stats.newTokens++;
      }
    }
    
    // 处理路由数据
    for (const row of section.tokenRoutes) {
      if (existingRouteIds.has(row.id)) {
        // 更新现有路由
        await tx.update(schema.tokenRoutes).set({
          modelPattern: row.modelPattern,
          displayName: row.displayName ?? null,
          displayIcon: row.displayIcon ?? null,
          modelMapping: row.modelMapping,
          routeMode: row.routeMode ?? 'pattern',
          decisionSnapshot: row.decisionSnapshot ?? null,
          decisionRefreshedAt: row.decisionRefreshedAt ?? null,
          routingStrategy: row.routingStrategy ?? 'weighted',
          enabled: row.enabled,
          updatedAt: row.updatedAt,
        }).where(eq(schema.tokenRoutes.id, row.id)).run();
      } else {
        // 插入新路由
        await tx.insert(schema.tokenRoutes).values({
          id: row.id,
          modelPattern: row.modelPattern,
          displayName: row.displayName ?? null,
          displayIcon: row.displayIcon ?? null,
          modelMapping: row.modelMapping,
          routeMode: row.routeMode ?? 'pattern',
          decisionSnapshot: row.decisionSnapshot ?? null,
          decisionRefreshedAt: row.decisionRefreshedAt ?? null,
          routingStrategy: row.routingStrategy ?? 'weighted',
          enabled: row.enabled,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }).run();
      }
    }
    
    // 处理路由组源
    if (section.routeGroupSources && section.routeGroupSources.length > 0) {
      // 先删除现有路由组源，再重新插入
      await tx.delete(schema.routeGroupSources).run();
      await batchInsertHelper(tx, schema.routeGroupSources, section.routeGroupSources.map((row) => ({
        id: row.id,
        groupRouteId: row.groupRouteId,
        sourceRouteId: row.sourceRouteId,
      })));
    }
    
    // 处理路由通道
    // 先删除现有路由通道，再重新插入（因为通道依赖关系复杂）
    await tx.delete(schema.routeChannels).run();
    await batchInsertHelper(tx, schema.routeChannels, section.routeChannels.map((row) => {
      const channelKey = importedIndexes.channelKeyById.get(row.id);
      const runtimeChannel = channelKey ? runtimeState.routeChannelRuntimeByKey.get(channelKey) : undefined;
      return {
        id: row.id,
        routeId: row.routeId,
        accountId: row.accountId,
        tokenId: row.tokenId,
        sourceModel: row.sourceModel ?? null,
        priority: row.priority,
        weight: row.weight,
        enabled: row.enabled,
        manualOverride: row.manualOverride,
        successCount: runtimeChannel?.successCount ?? row.successCount,
        failCount: runtimeChannel?.failCount ?? row.failCount,
        totalLatencyMs: runtimeChannel?.totalLatencyMs ?? row.totalLatencyMs,
        totalCost: runtimeChannel?.totalCost ?? row.totalCost,
        lastUsedAt: runtimeChannel?.lastUsedAt ?? row.lastUsedAt,
        lastSelectedAt: runtimeChannel?.lastSelectedAt ?? row.lastSelectedAt ?? null,
        lastFailAt: runtimeChannel?.lastFailAt ?? row.lastFailAt,
        consecutiveFailCount: runtimeChannel?.consecutiveFailCount ?? row.consecutiveFailCount ?? 0,
        cooldownLevel: runtimeChannel?.cooldownLevel ?? row.cooldownLevel ?? 0,
        cooldownUntil: runtimeChannel?.cooldownUntil ?? row.cooldownUntil,
      };
    }));
  });
  console.log('[backup] Smart core data import completed in', Date.now() - coreImportStartTime, 'ms');
  console.log('[backup] Import stats:', stats);

  // 第二步.5：清理不再存在的记录
  console.log('[backup] Starting cleanup of obsolete records');
  const cleanupStartTime = Date.now();
  
  await db.transaction(async (tx) => {
    // 清理不在备份中的站点
    const backupSiteKeys = new Set(section.sites.map(site => buildSiteIdentityKey(site)));
    for (const existingSite of existingSites) {
      if (!backupSiteKeys.has(buildSiteIdentityKey(existingSite))) {
        await tx.delete(schema.sites).where(eq(schema.sites.id, existingSite.id)).run();
      }
    }
    
    // 清理不在备份中的账号
    const backupAccountIds = new Set(section.accounts.map(account => account.id));
    for (const existingAccount of existingAccounts) {
      if (!backupAccountIds.has(existingAccount.id)) {
        await tx.delete(schema.accounts).where(eq(schema.accounts.id, existingAccount.id)).run();
      }
    }
    
    // 清理不在备份中的令牌
    const backupTokenIds = new Set(section.accountTokens.map(token => token.id));
    for (const existingToken of existingTokens) {
      if (!backupTokenIds.has(existingToken.id)) {
        await tx.delete(schema.accountTokens).where(eq(schema.accountTokens.id, existingToken.id)).run();
      }
    }
    
    // 清理不在备份中的路由
    const backupRouteIds = new Set(section.tokenRoutes.map(route => route.id));
    for (const existingRoute of existingRoutes) {
      if (!backupRouteIds.has(existingRoute.id)) {
        await tx.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, existingRoute.id)).run();
      }
    }
  });
  
  console.log('[backup] Cleanup completed in', Date.now() - cleanupStartTime, 'ms');

  // 第三步：插入辅助数据（小事务）
  console.log('[backup] Starting auxiliary data insertion transaction');
  const auxInsertStartTime = Date.now();
  await db.transaction(async (tx) => {
    if (shouldReplaceSiteDisabledModels) {
      const siteDisabledModelsRecords = (section.siteDisabledModels || []).map((row) => ({
        siteId: row.siteId,
        modelName: row.modelName,
      }));
      await batchInsertHelper(tx, schema.siteDisabledModels, siteDisabledModelsRecords);
    }

    const importedManualModelKeys = new Set<string>();
    if (shouldReplaceManualModels) {
      const checkedAt = new Date().toISOString();
      const manualModelsRecords = (section.manualModels || []).map((row) => {
        const accountKey = importedIndexes.accountKeyById.get(row.accountId);
        if (accountKey) {
          importedManualModelKeys.add(buildModelAvailabilityIdentityKey(accountKey, row.modelName));
        }
        return {
          accountId: row.accountId,
          modelName: row.modelName,
          available: true,
          isManual: true,
          latencyMs: null,
          checkedAt,
        };
      });
      await batchInsertHelper(tx, schema.modelAvailability, manualModelsRecords);
    }

    const nonManualAvailabilityRecords = runtimeState.nonManualAvailability
      .filter((row) => {
        if (!row.accountKey) return false;
        const accountId = importedIndexes.accountIdByKey.get(row.accountKey);
        if (!accountId) return false;
        return true;
      })
      .map((row) => {
        const accountKey = row.accountKey!;
        const accountId = importedIndexes.accountIdByKey.get(accountKey)!;
        const modelKey = buildModelAvailabilityIdentityKey(accountKey, row.modelName);
        return {
          accountId,
          modelName: row.modelName,
          available: row.available,
          isManual: false,
          latencyMs: row.latencyMs ?? null,
          checkedAt: row.checkedAt,
        };
      });
    await batchInsertHelper(tx, schema.modelAvailability, nonManualAvailabilityRecords);

    const tokenAvailabilityRecords = runtimeState.tokenAvailability
      .filter((row) => {
        if (!row.tokenKey) return false;
        const tokenId = importedIndexes.tokenIdByKey.get(row.tokenKey);
        return !!tokenId;
      })
      .map((row) => {
        const tokenKey = row.tokenKey!;
        const tokenId = importedIndexes.tokenIdByKey.get(tokenKey)!;
        return {
          tokenId,
          modelName: row.modelName,
          available: row.available,
          latencyMs: row.latencyMs ?? null,
          checkedAt: row.checkedAt,
      };
    });
    await batchInsertHelper(tx, schema.tokenModelAvailability, tokenAvailabilityRecords);

    const siteAnnouncementsRecords: typeof schema.siteAnnouncements.$inferInsert[] = [];
    for (const row of runtimeState.siteAnnouncements) {
      if (!row.siteKey) continue;
      const siteId = importedIndexes.siteIdByKey.get(row.siteKey);
      if (!siteId) continue;
      siteAnnouncementsRecords.push({
        siteId,
        platform: row.platform,
        sourceKey: row.sourceKey,
        title: row.title,
        content: row.content,
        level: row.level,
        sourceUrl: row.sourceUrl ?? null,
        startsAt: row.startsAt ?? null,
        endsAt: row.endsAt ?? null,
        upstreamCreatedAt: row.upstreamCreatedAt ?? null,
        upstreamUpdatedAt: row.upstreamUpdatedAt ?? null,
        firstSeenAt: row.firstSeenAt ?? null,
        lastSeenAt: row.lastSeenAt ?? null,
        readAt: row.readAt ?? null,
        dismissedAt: row.dismissedAt ?? null,
        rawPayload: row.rawPayload ?? null,
      });
    }
    await batchInsertHelper(tx, schema.siteAnnouncements, siteAnnouncementsRecords);
  });
  console.log('[backup] Auxiliary data insertion completed in', Date.now() - auxInsertStartTime, 'ms');

  // 第四步：插入下游API密钥（小事务）
  if (shouldReplaceDownstreamApiKeys) {
    console.log('[backup] Starting downstream API keys insertion transaction');
    const downstreamInsertStartTime = Date.now();
    await db.transaction(async (tx) => {
      for (const row of section.downstreamApiKeys || []) {
        const normalizedKey = asString(row.key);
        if (!normalizedKey) continue;
        const runtimeDownstream = runtimeState.downstreamApiKeyRuntimeByKey.get(normalizedKey);
        const insertedKey = await tx.insert(schema.downstreamApiKeys).values({
          name: row.name,
          key: normalizedKey,
          description: row.description ?? null,
          groupName: row.groupName ?? null,
          tags: row.tags ?? null,
          enabled: row.enabled ?? true,
          expiresAt: row.expiresAt ?? null,
          maxCost: row.maxCost ?? null,
          usedCost: runtimeDownstream?.usedCost ?? row.usedCost ?? 0,
          maxRequests: row.maxRequests ?? null,
          usedRequests: runtimeDownstream?.usedRequests ?? row.usedRequests ?? 0,
          supportedModels: row.supportedModels ?? null,
          allowedRouteIds: row.allowedRouteIds ?? null,
          siteWeightMultipliers: row.siteWeightMultipliers ?? null,
          excludedSiteIds: row.excludedSiteIds ?? null,
          excludedCredentialRefs: row.excludedCredentialRefs ?? null,
          lastUsedAt: runtimeDownstream?.lastUsedAt ?? row.lastUsedAt ?? null,
        }).run();
        requireInsertedRowId(
          insertedKey,
          `failed to import downstream api key: ${maskSecret(normalizedKey)}`,
        );
      }
    });
    console.log('[backup] Downstream API keys insertion completed in', Date.now() - downstreamInsertStartTime, 'ms');
  }

  // 第五步：插入日志数据（小事务）
  console.log('[backup] Starting logs insertion transaction');
  const logsInsertStartTime = Date.now();
  await db.transaction(async (tx) => {
    const proxyLogsRecords = runtimeState.proxyLogs.map((row) => {
      const accountId = row.accountKey ? (importedIndexes.accountIdByKey.get(row.accountKey) ?? null) : null;
      const routeId = row.routeKey ? (importedIndexes.routeIdByKey.get(row.routeKey) ?? null) : null;
      const channelId = row.channelKey ? (importedIndexes.channelIdByKey.get(row.channelKey) ?? null) : null;
      return {
        id: row.id,
        routeId,
        channelId,
        accountId,
        downstreamApiKeyId: null, // 简化处理，暂时设为null
        modelRequested: row.modelRequested ?? null,
        modelActual: row.modelActual ?? null,
        status: row.status ?? null,
        httpStatus: row.httpStatus ?? null,
        latencyMs: row.latencyMs ?? null,
        promptTokens: row.promptTokens ?? null,
        completionTokens: row.completionTokens ?? null,
        totalTokens: row.totalTokens ?? null,
        estimatedCost: row.estimatedCost ?? null,
        billingDetails: row.billingDetails ?? null,
        clientFamily: row.clientFamily ?? null,
        clientAppId: row.clientAppId ?? null,
        clientAppName: row.clientAppName ?? null,
        clientConfidence: row.clientConfidence ?? null,
        errorMessage: row.errorMessage ?? null,
        retryCount: row.retryCount ?? 0,
        createdAt: row.createdAt,
      };
    });
    await batchInsertHelper(tx, schema.proxyLogs, proxyLogsRecords);
    console.log('[backup] proxyLogs insertion completed in', Date.now() - logsInsertStartTime, 'ms, count:', proxyLogsRecords.length);

    const checkinLogsRecords = runtimeState.checkinLogs
      .filter((row) => row.accountKey && importedIndexes.accountIdByKey.get(row.accountKey))
      .map((row) => {
        const accountKey = row.accountKey!;
        return {
          id: row.id,
          accountId: importedIndexes.accountIdByKey.get(accountKey)!,
          status: row.status,
          message: row.message ?? null,
          reward: row.reward ?? null,
          createdAt: row.createdAt,
        };
      });
    await batchInsertHelper(tx, schema.checkinLogs, checkinLogsRecords);
    console.log('[backup] checkinLogs insertion completed in', Date.now() - logsInsertStartTime, 'ms, count:', checkinLogsRecords.length);
  });
  console.log('[backup] Logs insertion completed in', Date.now() - logsInsertStartTime, 'ms');
  
  console.log('[backup] importAccountsSection completed in', Date.now() - startTime, 'ms');
  
  // 计算统计数据
  stats.newSites = section.sites.length;
  stats.newAccounts = section.accounts.length;
  stats.newTokens = section.accountTokens.length;
  
  return stats;
}

async function importPreferencesSection(section: PreferencesBackupSection): Promise<{
  applied: Array<{ key: string; value: unknown }>;
  newSettings: number;
  updatedSettings: number;
}> {
  const applied: Array<{ key: string; value: unknown }> = [];
  let newSettings = 0;
  let updatedSettings = 0;

  await db.transaction(async (tx) => {
    for (const row of section.settings) {
      if (!isSettingValueAcceptable(row.key, row.value)) continue;

      // 检查设置是否已存在
      const existingRow = await tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, row.key)).get();
      if (existingRow) {
        updatedSettings++;
      } else {
        newSettings++;
      }

      await upsertSetting(row.key, row.value, tx);
      applied.push({ key: row.key, value: row.value });
    }
  });

  return { applied, newSettings, updatedSettings };
}

export async function importBackup(data: RawBackupData): Promise<BackupImportResult> {
  if (!isRecord(data)) {
    throw new Error('导入数据格式错误：必须为 JSON 对象');
  }

  if (!('timestamp' in data) || data.timestamp === null || data.timestamp === undefined) {
    throw new Error('导入数据格式错误：缺少 timestamp');
  }

  const accountsSection = detectAccountsSection(data);
  const preferencesSection = detectPreferencesSection(data);
  const importMetadata = detectImportMetadata(data);

  const type = typeof data.type === 'string' ? data.type : '';
  const accountsRequested = type === 'accounts' || !!accountsSection;
  const preferencesRequested = type === 'preferences' || !!preferencesSection;

  if (!accountsRequested && !preferencesRequested) {
    throw new Error('导入数据中没有可识别的账号或设置数据');
  }

  let accountsImported = false;
  let preferencesImported = false;
  let appliedSettings: Array<{ key: string; value: unknown }> = [];
  const errors: string[] = [];
  
  // 初始化统计数据
  let accountsStats = {
    newSites: 0,
    updatedSites: 0,
    newAccounts: 0,
    updatedAccounts: 0,
    newTokens: 0,
    updatedTokens: 0,
  };
  
  let settingsStats = {
    newSettings: 0,
    updatedSettings: 0,
  };

  if (accountsRequested) {
    if (!accountsSection) {
      errors.push('导入数据格式错误：账号数据结构不正确，请检查备份文件格式是否完整');
    } else {
      try {
        accountsStats = await importAccountsSection(accountsSection);
        accountsImported = true;
      } catch (error: any) {
        errors.push(`账号导入失败：${error.message}，请检查账号数据是否完整和格式是否正确`);
      }
    }
  }

  if (preferencesRequested) {
    if (!preferencesSection) {
      errors.push('导入数据格式错误：设置数据结构不正确，请检查备份文件格式是否完整');
    } else {
      try {
        const result = await importPreferencesSection(preferencesSection);
        appliedSettings = result.applied;
        settingsStats = {
          newSettings: result.newSettings,
          updatedSettings: result.updatedSettings,
        };
        preferencesImported = true;
      } catch (error: any) {
        errors.push(`设置导入失败：${error.message}，请检查设置数据是否有效和格式是否正确`);
      }
    }
  }

  // 合并统计数据
  const summary = {
    importedSites: importMetadata.summary?.importedSites || 0,
    importedAccounts: importMetadata.summary?.importedAccounts || 0,
    importedProfiles: importMetadata.summary?.importedProfiles || 0,
    importedApiKeyConnections: importMetadata.summary?.importedApiKeyConnections || 0,
    skippedAccounts: importMetadata.summary?.skippedAccounts || 0,
    ignoredSections: importMetadata.summary?.ignoredSections || [],
    newSites: accountsStats.newSites,
    updatedSites: accountsStats.updatedSites,
    newAccounts: accountsStats.newAccounts,
    updatedAccounts: accountsStats.updatedAccounts,
    newTokens: accountsStats.newTokens,
    updatedTokens: accountsStats.updatedTokens,
    newSettings: settingsStats.newSettings,
    updatedSettings: settingsStats.updatedSettings,
  };

  return {
    allImported: (!accountsRequested || accountsImported) && (!preferencesRequested || preferencesImported),
    sections: {
      accounts: accountsImported,
      preferences: preferencesImported,
    },
    appliedSettings,
    summary,
    warnings: importMetadata.warnings,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export async function getBackupWebdavConfig() {
  const [config, state] = await Promise.all([
    loadBackupWebdavConfig(),
    loadBackupWebdavState(),
  ]);
  return {
    success: true,
    config: toBackupWebdavConfigView(config),
    state,
  };
}

export async function saveBackupWebdavConfig(input: Partial<BackupWebdavConfig> & { password?: string; clearPassword?: boolean }) {
  const existing = await loadBackupWebdavConfig();
  const next: BackupWebdavConfig = {
    enabled: input.enabled !== undefined ? input.enabled === true : existing.enabled,
    fileUrl: input.fileUrl !== undefined ? asString(input.fileUrl) : existing.fileUrl,
    username: input.username !== undefined ? asString(input.username) : existing.username,
    password: input.clearPassword
      ? ''
      : (input.password !== undefined
        ? String(input.password)
        : existing.password),
    exportType: isValidBackupExportType(input.exportType) ? input.exportType : existing.exportType,
    autoSyncEnabled: input.autoSyncEnabled !== undefined ? input.autoSyncEnabled === true : existing.autoSyncEnabled,
    autoSyncCron: typeof input.autoSyncCron === 'string' && input.autoSyncCron.trim()
      ? input.autoSyncCron.trim()
      : existing.autoSyncCron,
  };

  if (!next.enabled) {
    next.autoSyncEnabled = false;
  }
  validateBackupWebdavConfig(next);

  await upsertSetting(BACKUP_WEBDAV_CONFIG_SETTING_KEY, next);
  await reloadBackupWebdavScheduler();
  return getBackupWebdavConfig();
}

export async function exportBackupToWebdav(type?: BackupExportType) {
  const config = await loadBackupWebdavConfig();
  validateBackupWebdavConfig(config);
  if (!config.enabled) {
    throw new Error('WebDAV 备份未启用');
  }
  if (!config.fileUrl) {
    throw new Error('WebDAV 文件地址不能为空');
  }

  const exportType = type && isValidBackupExportType(type) ? type : config.exportType;
  const payload = await exportBackup(exportType);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const authHeader = resolveBackupWebdavAuthHeader(config);
  if (authHeader) headers.Authorization = authHeader;

  try {
    const response = await fetchBackupWebdav(config.fileUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(payload, null, 2),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`WebDAV 导出失败：HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
    }

    const syncedAt = new Date().toISOString();
    await writeBackupWebdavState({
      lastSyncAt: syncedAt,
      lastError: null,
    });
    return {
      success: true,
      fileUrl: config.fileUrl,
      exportType,
      syncedAt,
      lastSyncAt: syncedAt,
      lastError: null,
    };
  } catch (error: any) {
    const previousState = await loadBackupWebdavState();
    await writeBackupWebdavState({
      lastSyncAt: previousState.lastSyncAt,
      lastError: error?.message || 'WebDAV 导出失败',
    });
    throw error;
  }
}

export async function importBackupFromWebdav() {
  const config = await loadBackupWebdavConfig();
  validateBackupWebdavConfig(config);
  if (!config.enabled) {
    throw new Error('WebDAV 备份未启用');
  }
  if (!config.fileUrl) {
    throw new Error('WebDAV 文件地址不能为空');
  }

  const headers: Record<string, string> = {};
  const authHeader = resolveBackupWebdavAuthHeader(config);
  if (authHeader) headers.Authorization = authHeader;

  try {
    const response = await fetchBackupWebdav(config.fileUrl, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`WebDAV 导入失败：HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
    }

    const raw = await response.text();
    const parsed = JSON.parse(raw) as RawBackupData;
    const result = await importBackup(parsed);
    const syncedAt = new Date().toISOString();
    await writeBackupWebdavState({
      lastSyncAt: syncedAt,
      lastError: null,
    });

    return {
      success: true,
      fileUrl: config.fileUrl,
      syncedAt,
      lastSyncAt: syncedAt,
      lastError: null,
      ...result,
    };
  } catch (error: any) {
    const previousState = await loadBackupWebdavState();
    await writeBackupWebdavState({
      lastSyncAt: previousState.lastSyncAt,
      lastError: error?.message || 'WebDAV 导入失败',
    });
    throw error;
  }
}

export async function reloadBackupWebdavScheduler() {
  stopBackupWebdavScheduler();
  const config = await loadBackupWebdavConfig();
  if (!config.enabled || !config.autoSyncEnabled) return;

  try {
    validateBackupWebdavConfig(config);
  } catch (error: any) {
    console.warn(`[backup/webdav] invalid config: ${error?.message || 'unknown error'}`);
    return;
  }

  backupWebdavTask = cron.schedule(config.autoSyncCron, () => {
    void exportBackupToWebdav(config.exportType).catch((error) => {
      console.warn(`[backup/webdav] auto sync failed: ${(error as Error)?.message || 'unknown error'}`);
    });
  });
}

export function __resetBackupWebdavSchedulerForTests() {
  stopBackupWebdavScheduler();
}
