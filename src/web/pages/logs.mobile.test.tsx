import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProxyLogs mobile layout', () => {
  it('renders mobile cards for proxy logs', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProxyLogs.tsx'), 'utf8');
    expect(source).toContain('MobileCard');
  });
});
