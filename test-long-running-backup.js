import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// 主测试函数
async function runLongRunningBackupTest() {
  console.log('开始测试长时间运行的备份导入操作...');
  
  // 创建临时数据目录
  const dataDir = mkdtempSync(join(tmpdir(), 'metapi-backup-test-'));
  process.env.DATA_DIR = dataDir;
  
  try {
    // 导入数据库模块
    await import('./src/server/db/migrate.ts');
    const { db, schema } = await import('./src/server/db/index.ts');
    const { importBackup, exportBackup } = await import('./src/server/services/backupService.ts');
    const { startBackgroundTask } = await import('./src/server/services/backgroundTaskService.ts');
    
    // 清理数据库
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
    
    console.log('数据库清理完成，开始生成大型测试数据...');
    
    // 生成大型测试数据
    const largeBackupData = generateLargeBackupData();
    console.log(`生成的数据规模：`);
    console.log(`- 站点数量: ${largeBackupData.accounts.sites.length}`);
    console.log(`- 账号数量: ${largeBackupData.accounts.accounts.length}`);
    console.log(`- 令牌数量: ${largeBackupData.accounts.accountTokens.length}`);
    console.log(`- 路由数量: ${largeBackupData.accounts.tokenRoutes.length}`);
    console.log(`- 通道数量: ${largeBackupData.accounts.routeChannels.length}`);
    
    // 记录开始时间
    const startTime = Date.now();
    console.log(`\n开始导入备份数据...`);
    
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

    console.log(`任务已启动，ID: ${task.id}, 状态: ${task.status}`);
    
    // 等待任务完成
    let attempts = 0;
    const maxAttempts = 300; // 最多等待 10 分钟（300 * 2秒）
    while (attempts < maxAttempts) {
      const { getBackgroundTask } = await import('./src/server/services/backgroundTaskService.ts');
      const currentTask = getBackgroundTask(task.id);
      
      if (!currentTask) {
        console.error('任务不存在');
        break;
      }
      
      console.log(`任务状态: ${currentTask.status} (${attempts * 2}s)`);
      
      if (currentTask.status === 'succeeded' || currentTask.status === 'failed') {
        break;
      }
      
      attempts++;
      // 每 2 秒检查一次
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 验证任务结果
    const { getBackgroundTask } = await import('./src/server/services/backgroundTaskService.ts');
    const finalTask = getBackgroundTask(task.id);
    
    if (!finalTask) {
      console.error('任务执行失败：任务不存在');
      return false;
    }
    
    if (finalTask.status === 'failed') {
      console.error(`任务执行失败：${finalTask.error}`);
      return false;
    }
    
    if (finalTask.status === 'succeeded') {
      console.log(`\n任务执行成功！`);
      console.log(`完成时间: ${Math.round((Date.now() - startTime) / 1000)}s`);
      
      // 验证数据导入成功
      const siteCount = await db.select({ count: db.fn.count() }).from(schema.sites).get();
      const accountCount = await db.select({ count: db.fn.count() }).from(schema.accounts).get();
      const tokenCount = await db.select({ count: db.fn.count() }).from(schema.accountTokens).get();
      const routeCount = await db.select({ count: db.fn.count() }).from(schema.tokenRoutes).get();
      const channelCount = await db.select({ count: db.fn.count() }).from(schema.routeChannels).get();
      
      console.log(`\n导入验证结果：`);
      console.log(`- 站点数量: ${Number(siteCount.count)} (预期: 100)`);
      console.log(`- 账号数量: ${Number(accountCount.count)} (预期: 1000)`);
      console.log(`- 令牌数量: ${Number(tokenCount.count)} (预期: 5000)`);
      console.log(`- 路由数量: ${Number(routeCount.count)} (预期: 50)`);
      console.log(`- 通道数量: ${Number(channelCount.count)} (预期: 1000)`);
      
      // 验证数据量是否正确
      const allCorrect = 
        Number(siteCount.count) === 100 &&
        Number(accountCount.count) === 1000 &&
        Number(tokenCount.count) === 5000 &&
        Number(routeCount.count) === 50 &&
        Number(channelCount.count) === 1000;
      
      if (allCorrect) {
        console.log('\n✓ 所有数据验证通过！');
      } else {
        console.log('\n✗ 数据验证失败！');
      }
      
      // 测试导出
      console.log('\n开始测试导出功能...');
      const exportStartTime = Date.now();
      const exportResult = await exportBackup('all');
      const exportTime = Math.round((Date.now() - exportStartTime) / 1000);
      console.log(`导出完成，耗时: ${exportTime}s`);
      
      if (exportResult) {
        console.log('✓ 导出成功！');
        console.log(`- 导出版本: ${exportResult.version}`);
        console.log(`- 导出站点数量: ${exportResult.accounts?.sites?.length}`);
        console.log(`- 导出账号数量: ${exportResult.accounts?.accounts?.length}`);
      } else {
        console.log('✗ 导出失败！');
      }
      
      return allCorrect && !!exportResult;
    }
    
  } catch (error) {
    console.error('测试过程中出现错误:', error);
    return false;
  } finally {
    // 清理临时目录
    delete process.env.DATA_DIR;
    try {
      rmSync(dataDir, { recursive: true, force: true });
      console.log('\n临时目录已清理');
    } catch (error) {
      console.error('清理临时目录时出错:', error);
    }
  }
}

// 运行测试
runLongRunningBackupTest()
  .then(success => {
    console.log(`\n测试结果: ${success ? '成功' : '失败'}`);
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('测试执行出错:', error);
    process.exit(1);
  });
