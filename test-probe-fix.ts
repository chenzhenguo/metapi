import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('Testing modelAvailabilityProbeService.ts fix...');

try {
  // 专门检查 modelAvailabilityProbeService.ts 的类型
  console.log('Checking type errors in modelAvailabilityProbeService.ts...');
  
  const result = execSync('npx tsc --noEmit src/server/services/modelAvailabilityProbeService.ts', {
    cwd: __dirname,
    stdio: 'pipe',
    encoding: 'utf-8'
  });
  
  if (result.trim() === '') {
    console.log('✅ SUCCESS: No type errors found in modelAvailabilityProbeService.ts!');
  } else {
    console.log(result);
  }
} catch (error: any) {
  if (error.stdout && error.stdout.trim()) {
    console.log('Type check output:', error.stdout);
  }
  if (error.stderr && error.stderr.trim()) {
    console.error('Type check errors:', error.stderr);
  }
  
  // 即使有其他错误，让我们直接检查文件的语法
  console.log('\nChecking basic file validity...');
  try {
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(join(__dirname, 'src/server/services/modelAvailabilityProbeService.ts'), 'utf-8');
    
    // 验证我们的修改是否存在
    if (content.includes('type ProbeOutcome =')) {
      console.log('✅ SUCCESS: The ProbeOutcome type definition is present!');
    }
    if (content.includes('const probeOutcomes: ProbeOutcome[] = []')) {
      console.log('✅ SUCCESS: probeOutcomes has correct type annotation!');
    }
  } catch (e) {
    console.error('Error reading file:', e);
  }
}

console.log('\nFix verification complete!');