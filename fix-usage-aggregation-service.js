// Fix for usageAggregationService.js error: onConflictDoNothing is not a function
// This script should be run in the deployed environment to fix the error

import fs from 'fs';
import path from 'path';

// Path to the usageAggregationService.js file
const servicePath = path.join(import.meta.dirname, 'dist/server/services/usageAggregationService.js');

// Read the file content
const content = fs.readFileSync(servicePath, 'utf8');

// Replace the onConflictDoNothing method with a compatible alternative
// The fix uses a try-catch approach to handle conflicts
const fixedContent = content.replace(
  /\.onConflictDoNothing\(\{\}\)(\s*\.all\(\))?/g,
  (match, allCall) => {
    if (allCall) {
      return ".run().catch(error => {\n        // Ignore duplicate key errors (conflicts)\n        if (error.message && (error.message.includes('duplicate key') || error.message.includes('UNIQUE constraint failed') || error.message.includes('Duplicate entry'))) {\n          return [];\n        }\n        throw error;\n      })";
    }
    return ".run().catch(error => {\n        // Ignore duplicate key errors (conflicts)\n        if (error.message && (error.message.includes('duplicate key') || error.message.includes('UNIQUE constraint failed') || error.message.includes('Duplicate entry'))) {\n          return { changes: 0 };\n        }\n        throw error;\n      })";
  }
);

// Write the fixed content back to the file
fs.writeFileSync(servicePath, fixedContent);

console.log('Fixed usageAggregationService.js: Replaced onConflictDoNothing with try-catch approach');
console.log('The fix handles conflicts by catching duplicate key errors and returning a no-op result');
