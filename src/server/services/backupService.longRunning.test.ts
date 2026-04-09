import { mkdtempSync, rmSync, join } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import { db, schema } from '../db/index.js';
import { importBackup, exportBackup } from './backupService.js';
import { startBackgroundTask } from './backgroundTaskService.js';

// 生成大型测试数据
function generateLargeBackupData() {
  const sites = [];
  const accounts = [];
  const accountTokens = [];
  const tokenRoutes = [];
  const routeChannels = [];

  // 生成 100 个站点
  for (let i = 1; i <= 100; i++) {
    sites.push({
      id: i,
      name: `Site ${i}`,
      url: `https://site${i}.example.com`,
      platform: 'new-api',
      status: 'active',
      isPinned: false,
      sortOrder: i - 1,
      globalWeight: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 每个站点生成 10 个账号
    for (let j = 1; j <= 10; j++) {
      const accountId = (i - 1) * 10 + j;
      accounts.push({
        id: accountId,
        siteId: i,
        username: `user${accountId}`,
        accessToken: `token${accountId}`,
        status: 'active',
        isPinned: false,
        sortOrder: j - 1,
        checkinEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // 每个账号生成 5 个令牌
      for (let k = 1; k <= 5; k++) {
        const tokenId = (accountId - 1) * 5 + k;
        accountTokens.push({
          id: tokenId,
          accountId,
          name: `Token ${k}`,
          token: `token_value${tokenId}`,
          tokenGroup: 'default',
          valueStatus: 'ready',
          source: 'manual',
          enabled: true,
          isDefault: k === 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  // 生成 50 个路由
  for (let i = 1; i <= 50; i++) {
    tokenRoutes.push({
      id: i,
      modelPattern: `model${i}.*`,
      displayName: `Route ${i}`,
      modelMapping: JSON.stringify({ 'model': `model${i}` }),
      routeMode: 'pattern',
      routingStrategy: 'weighted',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 每个路由生成 20 个通道
    for (let j = 1; j <= 20; j++) {
      const channelId = (i - 1) * 20 + j;
      routeChannels.push({
        id: channelId,
        routeId: i,
        accountId: ((i - 1) * 20 + j) % 1000 + 1, // 随机账号
        tokenId: ((i - 1) * 20 + j) % 5000 + 1, // 随机令牌
        priority: j,
        weight: 1,
        enabled: true,
        manualOverride: false,
      });
    }
  }

  return {
    version: '2.1',
    timestamp: Date.now(),
    accounts: {
      sites,
      accounts,
      accountTokens,
      tokenRoutes,
      routeChannels,
      routeGroupSources: [],
    },
  };
}

describe('backupService - long running operations', () => {
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-backup-service-long-running-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
  });

  beforeEach(async () => {
    // 清理所有表
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.siteAnnouncements).run();
    await db.delete(schema.siteDisabledModels).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.events).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('should handle large backup import without timeout', async () => {
    const largeBackupData = generateLargeBackupData();
    
    // 记录开始时间
    const startTime = Date.now();
    
    // 使用后台任务执行导入
    const { task, reused } = startBackgroundTask(
      {
        type: 'maintenance',
        title: 'Large Backup Import Test',
        dedupeKey: 'large-backup-import-test',
        notifyOnFailure: true,
        successMessage: (task) => `Large backup import completed in ${Math.round((Date.now() - startTime) / 1000)}s`,
        failureMessage: (task) => `Large backup import failed: ${task.error || 'unknown error'}`,
      },
      async () => {
        return await importBackup(largeBackupData);
      }
    );

    expect(reused).toBe(false);
    expect(task.status).toBe('pending');
    
    // 等待任务完成
    while (true) {
      const currentTask = await import('./backgroundTaskService.js').then(m => m.getBackgroundTask(task.id));
      if (!currentTask) {
        throw new Error('Task not found');
      }
      if (currentTask.status === 'succeeded' || currentTask.status === 'failed') {
        break;
      }
      // 每 2 秒检查一次
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 验证任务成功完成
    const finalTask = await import('./backgroundTaskService.js').then(m => m.getBackgroundTask(task.id));
    expect(finalTask).toBeTruthy();
    expect(finalTask.status).toBe('succeeded');
    
    // 验证数据导入成功
    const siteCount = await db.select({ count: db.fn.count() }).from(schema.sites).get();
    expect(Number(siteCount.count)).toBe(100);
    
    const accountCount = await db.select({ count: db.fn.count() }).from(schema.accounts).get();
    expect(Number(accountCount.count)).toBe(1000);
    
    const tokenCount = await db.select({ count: db.fn.count() }).from(schema.accountTokens).get();
    expect(Number(tokenCount.count)).toBe(5000);
    
    const routeCount = await db.select({ count: db.fn.count() }).from(schema.tokenRoutes).get();
    expect(Number(routeCount.count)).toBe(50);
    
    const channelCount = await db.select({ count: db.fn.count() }).from(schema.routeChannels).get();
    expect(Number(channelCount.count)).toBe(1000);
    
    console.log(`Large backup import completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
  }, 600000); // 10分钟超时

  it('should export large backup data without timeout', async () => {
    // 首先导入大型数据
    const largeBackupData = generateLargeBackupData();
    await importBackup(largeBackupData);
    
    // 记录开始时间
    const startTime = Date.now();
    
    // 导出数据
    const exportResult = await exportBackup('all');
    
    // 验证导出成功
    expect(exportResult).toBeTruthy();
    expect(exportResult.version).toBe('2.1');
    expect(exportResult.timestamp).toBeTruthy();
    expect(exportResult.accounts).toBeTruthy();
    expect(exportResult.preferences).toBeTruthy();
    
    // 验证导出的数据量
    expect(exportResult.accounts?.sites?.length).toBe(100);
    expect(exportResult.accounts?.accounts?.length).toBe(1000);
    expect(exportResult.accounts?.accountTokens?.length).toBe(5000);
    expect(exportResult.accounts?.tokenRoutes?.length).toBe(50);
    expect(exportResult.accounts?.routeChannels?.length).toBe(1000);
    
    console.log(`Large backup export completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
  }, 300000); // 5分钟超时

  it('should handle sequential large operations without interference', async () => {
    // 记录开始时间
    const startTime = Date.now();
    
    // 第一次导入
    const firstBackupData = generateLargeBackupData();
    await importBackup(firstBackupData);
    
    console.log(`First import completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
    
    // 导出
    const exportResult = await exportBackup('all');
    
    console.log(`Export completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
    
    // 第二次导入（不同数据）
    const secondBackupData = {
      ...generateLargeBackupData(),
      timestamp: Date.now(), // 不同的时间戳
    };
    await importBackup(secondBackupData);
    
    console.log(`Second import completed in ${Math.round((Date.now() - startTime) / 1000)}s`);
    
    // 验证最终数据
    const siteCount = await db.select({ count: db.fn.count() }).from(schema.sites).get();
    expect(Number(siteCount.count)).toBe(100);
    
    const accountCount = await db.select({ count: db.fn.count() }).from(schema.accounts).get();
    expect(Number(accountCount.count)).toBe(1000);
  }, 900000); // 15分钟超时
});
