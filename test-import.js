import { importBackup } from './src/server/services/backupService.ts';

// 测试用例 1: 完整的备份文件
const fullBackup = {
  version: '2.1',
  timestamp: Date.now(),
  accounts: {
    sites: [
      {
        id: 1,
        name: 'Test Site',
        url: 'https://test.com',
        platform: 'openai',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    accounts: [
      {
        id: 1,
        siteId: 1,
        username: 'testuser',
        accessToken: 'testtoken',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    accountTokens: [],
    tokenRoutes: [],
    routeChannels: [],
    routeGroupSources: []
  },
  preferences: {
    settings: [
      {
        key: 'test_key',
        value: 'test_value'
      }
    ]
  }
};

// 测试用例 2: 部分数据缺失的备份文件
const partialBackup = {
  version: '2.1',
  timestamp: Date.now(),
  accounts: {
    sites: [
      {
        id: 1,
        name: 'Test Site',
        url: 'https://test.com',
        platform: 'openai',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    // 缺少 accountTokens, tokenRoutes, routeChannels
    accounts: [
      {
        id: 1,
        siteId: 1,
        username: 'testuser',
        accessToken: 'testtoken',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    routeGroupSources: []
  },
  preferences: {
    // 空设置
    settings: []
  }
};

// 测试用例 3: 只有设置的备份文件
const preferencesOnlyBackup = {
  version: '2.1',
  timestamp: Date.now(),
  type: 'preferences',
  preferences: {
    settings: [
      {
        key: 'test_key',
        value: 'test_value'
      }
    ]
  }
};

// 测试用例 4: 只有账号的备份文件
const accountsOnlyBackup = {
  version: '2.1',
  timestamp: Date.now(),
  type: 'accounts',
  accounts: {
    sites: [
      {
        id: 1,
        name: 'Test Site',
        url: 'https://test.com',
        platform: 'openai',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    accounts: [
      {
        id: 1,
        siteId: 1,
        username: 'testuser',
        accessToken: 'testtoken',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    accountTokens: [],
    tokenRoutes: [],
    routeChannels: [],
    routeGroupSources: []
  }
};

async function runTests() {
  console.log('开始测试导入功能...');
  
  try {
    console.log('\n测试用例 1: 完整的备份文件');
    const result1 = await importBackup(fullBackup);
    console.log('导入结果:', result1);
    console.log('账号导入:', result1.sections.accounts);
    console.log('设置导入:', result1.sections.preferences);
  } catch (error) {
    console.error('测试用例 1 失败:', error.message);
  }
  
  try {
    console.log('\n测试用例 2: 部分数据缺失的备份文件');
    const result2 = await importBackup(partialBackup);
    console.log('导入结果:', result2);
    console.log('账号导入:', result2.sections.accounts);
    console.log('设置导入:', result2.sections.preferences);
  } catch (error) {
    console.error('测试用例 2 失败:', error.message);
  }
  
  try {
    console.log('\n测试用例 3: 只有设置的备份文件');
    const result3 = await importBackup(preferencesOnlyBackup);
    console.log('导入结果:', result3);
    console.log('账号导入:', result3.sections.accounts);
    console.log('设置导入:', result3.sections.preferences);
  } catch (error) {
    console.error('测试用例 3 失败:', error.message);
  }
  
  try {
    console.log('\n测试用例 4: 只有账号的备份文件');
    const result4 = await importBackup(accountsOnlyBackup);
    console.log('导入结果:', result4);
    console.log('账号导入:', result4.sections.accounts);
    console.log('设置导入:', result4.sections.preferences);
  } catch (error) {
    console.error('测试用例 4 失败:', error.message);
  }
  
  console.log('\n测试完成');
}

runTests();