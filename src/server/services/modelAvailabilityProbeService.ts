import { and, asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { startBackgroundTask } from './backgroundTaskService.js';
import { isUsableAccountToken, ACCOUNT_TOKEN_VALUE_STATUS_READY } from './accountTokenService.js';
import { probeRuntimeModel } from './runtimeModelProbe.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';

type ProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

type ProbeAccountTarget = {
  kind: 'account';
  rowId: number;
  modelName: string;
  lastKnownAvailable: boolean;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

type ProbeTokenTarget = {
  kind: 'token';
  rowId: number;
  tokenId: number;
  modelName: string;
  tokenValue: string;
  lastKnownAvailable: boolean;
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

type ProbeTarget = ProbeAccountTarget | ProbeTokenTarget;
type ProbeAccountContext = {
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
};

export type ModelAvailabilityProbeAccountResult = {
  accountId: number;
  siteId: number;
  status: 'success' | 'failed' | 'skipped';
  scanned: number;
  supported: number;
  unsupported: number;
  inconclusive: number;
  skipped: number;
  updatedRows: number;
  message: string;
};

export type ModelAvailabilityProbeExecutionResult = {
  results: ModelAvailabilityProbeAccountResult[];
  summary: {
    totalAccounts: number;
    success: number;
    failed: number;
    skipped: number;
    scanned: number;
    supported: number;
    unsupported: number;
    inconclusive: number;
    skippedModels: number;
    updatedRows: number;
    rebuiltRoutes: boolean;
  };
};

let probeSchedulerTimer: ReturnType<typeof setInterval> | null = null;
const probeAccountLeases = new Set<number>();
const probeSiteLeases = new Set<number>();

// 站点测活记录，用于频率限制
interface SiteProbeRecord {
  count: number;
  lastProbeTime: number;
}
const siteProbeRecords = new Map<number, SiteProbeRecord>();

// 检查站点测活频率是否超过限制
function checkSiteProbeFrequency(siteId: number): boolean {
  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;
  const MAX_PROBES_PER_FIVE_MINUTES = config.modelAvailabilityProbeMaxPerFiveMinutes;
  
  const record = siteProbeRecords.get(siteId);
  if (!record) {
    // 第一次测活，创建记录
    siteProbeRecords.set(siteId, {
      count: 1,
      lastProbeTime: now,
    });
    return true;
  }
  
  // 检查是否在 5 分钟窗口内
  if (now - record.lastProbeTime < FIVE_MINUTES) {
    if (record.count >= MAX_PROBES_PER_FIVE_MINUTES) {
      return false; // 超过限制
    }
    // 在窗口内，增加计数
    siteProbeRecords.set(siteId, {
      count: record.count + 1,
      lastProbeTime: record.lastProbeTime,
    });
  } else {
    // 超过 5 分钟，重置记录
    siteProbeRecords.set(siteId, {
      count: 1,
      lastProbeTime: now,
    });
  }
  return true;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Math.trunc(concurrency || 1)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
  return results;
}

async function probeSingleTarget(target: ProbeTarget): Promise<{
  status: ProbeStatus;
  latencyMs: number | null;
  reason: string;
}> {
  return await probeRuntimeModel({
    site: target.site,
    account: target.account,
    modelName: target.modelName,
    timeoutMs: config.modelAvailabilityProbeTimeoutMs,
    tokenValue: target.kind === 'token' ? target.tokenValue : undefined,
  });
}

async function updateProbeRow(target: ProbeTarget, status: ProbeStatus, latencyMs: number | null): Promise<{
  touched: boolean;
  availabilityChanged: boolean;
}> {
  if (status === 'inconclusive' || status === 'skipped') {
    return {
      touched: false,
      availabilityChanged: false,
    };
  }
  const nextAvailable = status === 'supported';
  const patch = {
    available: nextAvailable,
    latencyMs,
    checkedAt: new Date().toISOString(),
  };

  if (target.kind === 'account') {
    await db.update(schema.modelAvailability)
      .set(patch)
      .where(eq(schema.modelAvailability.id, target.rowId))
      .run();
    return {
      touched: true,
      availabilityChanged: target.lastKnownAvailable !== nextAvailable,
    };
  }

  await db.update(schema.tokenModelAvailability)
    .set(patch)
    .where(eq(schema.tokenModelAvailability.id, target.rowId))
    .run();
  return {
    touched: true,
    availabilityChanged: target.lastKnownAvailable !== nextAvailable,
  };
}

async function loadActiveProbeAccountContext(accountId: number): Promise<ProbeAccountContext | null> {
  const accountRow = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!accountRow) return null;
  if ((accountRow.accounts.status || 'active') !== 'active') return null;
  if ((accountRow.sites.status || 'active') !== 'active') return null;
  return {
    account: accountRow.accounts,
    site: accountRow.sites,
  };
}

async function loadProbeTargetsForAccount(context: ProbeAccountContext): Promise<ProbeTarget[]> {
  const targets: ProbeTarget[] = [];
  const accountModels = await db.select()
    .from(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, context.account.id))
    .orderBy(asc(schema.modelAvailability.checkedAt))
    .all();
  for (const row of accountModels) {
    if (row.isManual) continue;
    targets.push({
      kind: 'account',
      rowId: row.id,
      modelName: row.modelName,
      lastKnownAvailable: !!row.available,
      account: context.account,
      site: context.site,
    });
  }

  const tokenRows = await db.select()
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.accountTokens.accountId, context.account.id),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .orderBy(asc(schema.tokenModelAvailability.checkedAt))
    .all();
  for (const row of tokenRows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const tokenValue = String(row.account_tokens.token || '').trim();
    if (!tokenValue) continue;
    targets.push({
      kind: 'token',
      rowId: row.token_model_availability.id,
      tokenId: row.account_tokens.id,
      modelName: row.token_model_availability.modelName,
      tokenValue,
      lastKnownAvailable: !!row.token_model_availability.available,
      account: context.account,
      site: context.site,
    });
  }

  return targets;
}

function tryAcquireProbeAccountLease(accountId: number, siteId: number): boolean {
  if (!Number.isFinite(accountId) || accountId <= 0) return false;
  if (!Number.isFinite(siteId) || siteId <= 0) return false;
  if (probeAccountLeases.has(accountId)) return false;
  if (probeSiteLeases.has(siteId)) return false;
  probeAccountLeases.add(accountId);
  probeSiteLeases.add(siteId);
  return true;
}

function releaseProbeAccountLease(accountId: number, siteId: number): void {
  probeAccountLeases.delete(accountId);
  probeSiteLeases.delete(siteId);
}

function buildSkippedProbeAccountResult(input: {
  accountId: number;
  siteId: number;
  message: string;
}): ModelAvailabilityProbeAccountResult {
  return {
    accountId: input.accountId,
    siteId: input.siteId,
    status: 'skipped',
    scanned: 0,
    supported: 0,
    unsupported: 0,
    inconclusive: 0,
    skipped: 0,
    updatedRows: 0,
    message: input.message,
  };
}

function summarizeProbeResults(results: ModelAvailabilityProbeAccountResult[], rebuiltRoutes: boolean): ModelAvailabilityProbeExecutionResult {
  return {
    results,
    summary: {
      totalAccounts: results.length,
      success: results.filter((item) => item.status === 'success').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      scanned: results.reduce((sum, item) => sum + item.scanned, 0),
      supported: results.reduce((sum, item) => sum + item.supported, 0),
      unsupported: results.reduce((sum, item) => sum + item.unsupported, 0),
      inconclusive: results.reduce((sum, item) => sum + item.inconclusive, 0),
      skippedModels: results.reduce((sum, item) => sum + item.skipped, 0),
      updatedRows: results.reduce((sum, item) => sum + item.updatedRows, 0),
      rebuiltRoutes,
    },
  };
}

export async function executeModelAvailabilityProbe(input: {
  accountId?: number;
  rebuildRoutes?: boolean;
} = {}): Promise<ModelAvailabilityProbeExecutionResult> {
  // 获取所有活跃账号及其站点信息
  const accountRows = input.accountId
    ? (await db.select({
        id: schema.accounts.id,
        siteId: schema.accounts.siteId,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.accountId))
      .all())
    : (await db.select({
        id: schema.accounts.id,
        siteId: schema.accounts.siteId,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.status, 'active'))
      .all());

  // 按站点分组
  const accountsBySite = new Map<number, number[]>();
  for (const row of accountRows) {
    if (!accountsBySite.has(row.siteId)) {
      accountsBySite.set(row.siteId, []);
    }
    accountsBySite.get(row.siteId)?.push(row.id);
  }

  const results: ModelAvailabilityProbeAccountResult[] = [];
  let shouldRebuildRoutes = false;

  // 并行处理不同站点
  const sitePromises = Array.from(accountsBySite.entries()).map(async ([siteId, siteAccountIds]) => {
    // 站点级串行处理
    for (const accountId of siteAccountIds) {
      const context = await loadActiveProbeAccountContext(accountId);
      if (!context) {
        continue;
      }
      if (!checkSiteProbeFrequency(siteId)) {
        results.push(buildSkippedProbeAccountResult({
          accountId,
          siteId: context.site.id,
          message: 'model availability probe frequency limit exceeded for site',
        }));
        continue;
      }
      if (!tryAcquireProbeAccountLease(accountId, siteId)) {
        results.push(buildSkippedProbeAccountResult({
          accountId,
          siteId: context.site.id,
          message: 'model availability probe already running for account or site',
        }));
        continue;
      }

      try {
        const targets = await loadProbeTargetsForAccount(context);
        if (targets.length <= 0) {
          results.push(buildSkippedProbeAccountResult({
            accountId,
            siteId: context.site.id,
            message: 'no discovered models to probe',
          }));
          continue;
        }

        let supported = 0;
        let unsupported = 0;
        let inconclusive = 0;
        let skipped = 0;
        let updatedRows = 0;
        let failed = false;

        // 串行处理模型（TPM=1）
        const probeOutcomes = [];
        for (const target of targets) {
          try {
            // 添加延迟确保 TPM 限制
            const delayMs = Math.round(60000 / config.modelAvailabilityProbeTpm);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            const probe = await probeSingleTarget(target);
            const update = await updateProbeRow(target, probe.status, probe.latencyMs);
            probeOutcomes.push({
              target,
              probe,
              touched: update.touched,
              availabilityChanged: update.availabilityChanged,
              failed: false,
            });
          } catch (error) {
            console.warn(`[model-probe] account ${accountId} model ${target.modelName} probe failed`, error);
            probeOutcomes.push({
              target,
              probe: {
                status: 'inconclusive' as const,
                latencyMs: null,
                reason: error instanceof Error ? error.message : 'probe failed',
              },
              touched: false,
              availabilityChanged: false,
              failed: true,
            });
          }
        }

        for (const outcome of probeOutcomes) {
          if (outcome.probe.status === 'supported') supported += 1;
          if (outcome.probe.status === 'unsupported') unsupported += 1;
          if (outcome.probe.status === 'inconclusive') inconclusive += 1;
          if (outcome.probe.status === 'skipped') skipped += 1;
          if (outcome.touched) {
            updatedRows += 1;
          }
          if (outcome.availabilityChanged) {
            shouldRebuildRoutes = true;
          }
          if (outcome.failed) {
            failed = true;
          }
        }

        results.push({
          accountId,
          siteId: context.site.id,
          status: failed ? 'failed' : 'success',
          scanned: targets.length,
          supported,
          unsupported,
          inconclusive,
          skipped,
          updatedRows,
          message: failed
            ? 'model availability probe finished with partial failures'
            : 'model availability probe finished',
        });
      } finally {
        releaseProbeAccountLease(accountId, siteId);
      }
    }
  });

  // 等待所有站点处理完成
  await Promise.all(sitePromises);

  let rebuiltRoutes = false;
  if (input.rebuildRoutes !== false && shouldRebuildRoutes) {
    await routeRefreshWorkflow.rebuildRoutesOnly();
    rebuiltRoutes = true;
  }

  return summarizeProbeResults(results, rebuiltRoutes);
}

export function buildModelAvailabilityProbeTaskDedupeKey(accountId?: number | null): string {
  const normalizedAccountId = Number.isFinite(accountId as number) && Number(accountId) > 0
    ? Math.trunc(Number(accountId))
    : null;
  return normalizedAccountId
    ? `model-availability-probe-${normalizedAccountId}`
    : 'model-availability-probe-all';
}

export function queueModelAvailabilityProbeTask(input: {
  accountId?: number;
  title?: string;
}) {
  const accountId = Number.isFinite(input.accountId as number) ? Math.trunc(input.accountId as number) : null;
  const title = input.title || (accountId
    ? `探测模型可用性 #${accountId}`
    : '探测模型可用性');
  const dedupeKey = buildModelAvailabilityProbeTaskDedupeKey(accountId);

  return startBackgroundTask(
    {
      type: 'model-probe',
      title,
      dedupeKey,
      notifyOnFailure: true,
      successMessage: (currentTask) => {
        const summary = (currentTask.result as ModelAvailabilityProbeExecutionResult | undefined)?.summary;
        if (!summary) return `${title}已完成`;
        return `${title}完成：探测 ${summary.scanned}，可用 ${summary.supported}，不可用 ${summary.unsupported}，不确定 ${summary.inconclusive}`;
      },
      failureMessage: (currentTask) => `${title}失败：${currentTask.error || 'unknown error'}`,
    },
    async () => executeModelAvailabilityProbe({
      accountId: accountId ?? undefined,
      rebuildRoutes: true,
    }),
  );
}

export function startModelAvailabilityProbeScheduler(intervalMs = config.modelAvailabilityProbeIntervalMs) {
  stopModelAvailabilityProbeScheduler();
  if (!config.modelAvailabilityProbeEnabled) {
    return {
      enabled: false,
      intervalMs: 0,
    };
  }

  const safeIntervalMs = Math.max(60_000, Math.trunc(intervalMs || 0));
  probeSchedulerTimer = setInterval(() => {
    void queueModelAvailabilityProbeTask({
      title: '后台模型可用性探测',
    });
  }, safeIntervalMs);
  // 尝试 unref，如果可用的话
  if (typeof probeSchedulerTimer === 'object' && probeSchedulerTimer !== null && 'unref' in probeSchedulerTimer) {
    probeSchedulerTimer.unref();
  }
  return {
    enabled: true,
    intervalMs: safeIntervalMs,
  };
}

export function stopModelAvailabilityProbeScheduler() {
  if (probeSchedulerTimer) {
    clearInterval(probeSchedulerTimer);
    probeSchedulerTimer = null;
  }
}

export function __resetModelAvailabilityProbeExecutionStateForTests(): void {
  probeAccountLeases.clear();
  probeSiteLeases.clear();
}
