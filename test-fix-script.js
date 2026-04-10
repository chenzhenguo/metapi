// Test script for the usageAggregationService fix
import fs from 'fs';
import path from 'path';

// Create a test version of usageAggregationService.js with the problematic code
const testFilePath = path.join(import.meta.dirname, 'test-usageAggregationService.js');

// Test content with onConflictDoNothing calls
const testContent = `
async function ensureProjectionCheckpointExists(db, checkpointId) {
  await db.insert({ id: checkpointId, createdAt: new Date() })
    .values({ /* values */ })
    .onConflictDoNothing({});
}

async function anotherFunctionWithConflict(db, data) {
  return db.insert(data)
    .values({ /* values */ })
    .onConflictDoNothing({})
    .all();
}`;

// Write test file
fs.writeFileSync(testFilePath, testContent);
console.log('Created test file with onConflictDoNothing calls');

// Import the fix script logic
const fixScriptPath = path.join(import.meta.dirname, 'fix-usage-aggregation-service.js');
const fixScriptContent = fs.readFileSync(fixScriptPath, 'utf8');

// Modify the fix script to work with our test file
const modifiedFixScript = fixScriptContent
  .replace(/const servicePath = path\.join\(import\.meta\.dirname, 'dist\/server\/services\/usageAggregationService\.js'\);/g,
    "const servicePath = path.join(import.meta.dirname, 'test-usageAggregationService.js');");

// Write the modified fix script
const testFixScriptPath = path.join(import.meta.dirname, 'test-fix-script-exec.js');
fs.writeFileSync(testFixScriptPath, modifiedFixScript);
console.log('Created test fix script');

// Run the fix script
await import(testFixScriptPath);

// Read the fixed content
const fixedContent = fs.readFileSync(testFilePath, 'utf8');
console.log('\nFixed content:');
console.log(fixedContent);

// Verify the fix was applied correctly
const hasTryCatch = fixedContent.includes('.run().catch(error =>');
const hasDuplicateKeyCheck = fixedContent.includes('duplicate key') && fixedContent.includes('UNIQUE constraint failed') && fixedContent.includes('Duplicate entry');
const hasOnConflictDoNothing = fixedContent.includes('onConflictDoNothing');

console.log('\nVerification results:');
console.log('Has try-catch approach:', hasTryCatch);
console.log('Has duplicate key error handling:', hasDuplicateKeyCheck);
console.log('Still has onConflictDoNothing:', hasOnConflictDoNothing);

// Clean up test files
fs.unlinkSync(testFilePath);
fs.unlinkSync(testFixScriptPath);
console.log('\nCleaned up test files');

if (hasTryCatch && hasDuplicateKeyCheck && !hasOnConflictDoNothing) {
  console.log('\n✅ Fix script test PASSED!');
} else {
  console.log('\n❌ Fix script test FAILED!');
}
