// 简单的长时间运行数据库操作测试脚本
import { db, runtimeDbDialect } from './src/server/db/index.js';

async function simulateLongRunningOperation(seconds) {
  console.log(`Starting long running operation (target: ${seconds} seconds)`);
  const startTime = Date.now();
  
  try {
    // 创建临时表
    if (runtimeDbDialect === 'sqlite') {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS test_long_running (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } else if (runtimeDbDialect === 'mysql') {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS test_long_running (
          id INT PRIMARY KEY AUTO_INCREMENT,
          data TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);
    } else if (runtimeDbDialect === 'postgres') {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS test_long_running (
          id SERIAL PRIMARY KEY,
          data TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 分批次插入数据
    console.log('Inserting test data...');
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
        const currentTime = (Date.now() - startTime) / 1000;
        console.log(`Progress: ${i * 1000} records inserted (${currentTime.toFixed(2)} seconds)`);
        // 模拟处理时间
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // 清理临时表
    console.log('Cleaning up temporary table...');
    await db.execute('DROP TABLE IF EXISTS test_long_running');
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    console.log(`Long running operation completed in ${duration.toFixed(2)} seconds`);
    
    if (duration >= seconds) {
      console.log(`✅ SUCCESS: Operation lasted more than ${seconds} seconds without timeout`);
      return true;
    } else {
      console.log(`⚠️  WARNING: Operation completed in ${duration.toFixed(2)} seconds (less than ${seconds} seconds)`);
      return false;
    }
  } catch (error) {
    console.error('❌ ERROR during long running operation:', error);
    // 尝试清理临时表
    try {
      await db.execute('DROP TABLE IF EXISTS test_long_running');
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }
    return false;
  }
}

async function runTests() {
  console.log('=== Long Running Database Operations Test ===');
  console.log(`Database dialect: ${runtimeDbDialect}`);
  console.log('===========================================');
  
  // 测试超过60秒的操作
  console.log('\nTest 1: Operation lasting more than 60 seconds');
  const test1Result = await simulateLongRunningOperation(60);
  
  // 测试多个长时间运行的操作
  console.log('\nTest 2: Multiple long-running operations');
  const results = [];
  for (let i = 0; i < 3; i++) {
    console.log(`\nRunning operation ${i + 1}/3`);
    const result = await simulateLongRunningOperation(10);
    results.push(result);
  }
  
  // 测试数据库连接稳定性
  console.log('\nTest 3: Database connection stability');
  await simulateLongRunningOperation(30);
  try {
    const result = await db.execute('SELECT 1');
    console.log('✅ SUCCESS: Database connection is still stable');
  } catch (error) {
    console.error('❌ ERROR: Database connection failed after long operation:', error);
  }
  
  console.log('\n=== Test Summary ===');
  console.log(`Test 1 (60+ seconds): ${test1Result ? 'PASS' : 'FAIL'}`);
  console.log(`Test 2 (Multiple operations): ${results.every(r => r) ? 'PASS' : 'FAIL'}`);
  console.log('Test 3 (Connection stability): Check logs above');
  console.log('==================');
}

// 运行测试
runTests().catch(console.error);
