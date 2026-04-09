import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, closeDbConnections, runtimeDbDialect } from './index.js';
import * as schema from './schema.js';

// 模拟长时间运行的数据库操作
async function simulateLongRunningOperation(seconds: number): Promise<boolean> {
  const startTime = Date.now();
  
  // 创建一个大表或执行大量插入操作
  if (runtimeDbDialect === 'sqlite') {
    // SQLite: 创建临时表并插入大量数据
    await db.execute(`
      CREATE TABLE IF NOT EXISTS test_long_running (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 分批次插入数据，每批次1000条，共插入50000条
    for (let i = 0; i < 50; i++) {
      const values = [];
      for (let j = 0; j < 1000; j++) {
        const data = `test_data_${i}_${j}_${Math.random()}`;
        values.push(`('${data}')`);
      }
      await db.execute(`
        INSERT INTO test_long_running (data) VALUES ${values.join(', ')}
      `);
      
      // 模拟处理时间
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // 清理临时表
    await db.execute('DROP TABLE IF EXISTS test_long_running');
  } else if (runtimeDbDialect === 'mysql') {
    // MySQL: 创建临时表并插入大量数据
    await db.execute(`
      CREATE TABLE IF NOT EXISTS test_long_running (
        id INT PRIMARY KEY AUTO_INCREMENT,
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);
    
    // 分批次插入数据
    for (let i = 0; i < 50; i++) {
      const values = [];
      for (let j = 0; j < 1000; j++) {
        const data = `test_data_${i}_${j}_${Math.random()}`;
        values.push(`('${data}')`);
      }
      await db.execute(`
        INSERT INTO test_long_running (data) VALUES ${values.join(', ')}
      `);
      
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await db.execute('DROP TABLE IF EXISTS test_long_running');
  } else if (runtimeDbDialect === 'postgres') {
    // PostgreSQL: 创建临时表并插入大量数据
    await db.execute(`
      CREATE TABLE IF NOT EXISTS test_long_running (
        id SERIAL PRIMARY KEY,
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 分批次插入数据
    for (let i = 0; i < 50; i++) {
      const values = [];
      for (let j = 0; j < 1000; j++) {
        const data = `test_data_${i}_${j}_${Math.random()}`;
        values.push(`('${data}')`);
      }
      await db.execute(`
        INSERT INTO test_long_running (data) VALUES ${values.join(', ')}
      `);
      
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await db.execute('DROP TABLE IF EXISTS test_long_running');
  }
  
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  console.log(`Long running operation completed in ${duration.toFixed(2)} seconds`);
  
  return duration >= seconds;
}

describe('Long Running Database Operations', () => {
  beforeEach(async () => {
    // 确保数据库连接已初始化
    await db.execute('SELECT 1');
  });
  
  afterEach(async () => {
    // 清理测试数据
    if (runtimeDbDialect === 'sqlite') {
      await db.execute('DROP TABLE IF EXISTS test_long_running');
    } else if (runtimeDbDialect === 'mysql') {
      await db.execute('DROP TABLE IF EXISTS test_long_running');
    } else if (runtimeDbDialect === 'postgres') {
      await db.execute('DROP TABLE IF EXISTS test_long_running');
    }
  });
  
  it('should handle operations lasting more than 60 seconds without timeout', async () => {
    // 测试超过60秒的操作
    const completed = await simulateLongRunningOperation(60);
    expect(completed).toBe(true);
  });
  
  it('should handle multiple long-running operations sequentially', async () => {
    // 测试多个长时间运行的操作
    const results = [];
    for (let i = 0; i < 3; i++) {
      const completed = await simulateLongRunningOperation(10);
      results.push(completed);
    }
    
    // 所有操作都应该成功完成
    expect(results.every(r => r)).toBe(true);
  });
  
  it('should maintain database connection after long operations', async () => {
    // 执行长时间操作
    await simulateLongRunningOperation(30);
    
    // 验证连接仍然可用
    const result = await db.execute('SELECT 1');
    expect(result).toBeDefined();
  });
});
