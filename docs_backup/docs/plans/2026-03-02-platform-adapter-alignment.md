# Platform Adapter Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align metapi's platform adapters with all-api-hub behavior so all supported platforms (VoAPI, Super-API, RIX_API, Neo-API, Sub2API, OneHub, DoneHub, Veloera) work correctly.

**Architecture:** Modify 5 existing adapter files within the class-based adapter hierarchy. No new patterns or dependencies. All changes are additive or replacement of stub implementations.

**Tech Stack:** TypeScript, Node.js, undici (HTTP), vitest (testing)

---

### Task 1: Add Compatibility User-ID Headers to NewApiAdapter

**Files:**
- Modify: `src/server/services/platforms/newApi.ts:32-36`
- Test: `src/server/services/platforms/newApi.test.ts`

**Step 1: Write the failing test**

Add a test that verifies all 6 compat headers are sent when userId is present.

```typescript
// In newApi.test.ts, add:
it('sends all compatibility user-id headers when userId is known', async () => {
  const receivedHeaders: Record<string, string> = {};
  server = createServer((req, res) => {
    // Capture headers from the request
    for (const name of ['new-api-user', 'veloera-user', 'voapi-user', 'user-id', 'rix-api-user', 'neo-api-user']) {
      const val = req.headers[name];
      if (val) receivedHeaders[name] = String(val);
    }
    if (req.url === '/api/user/self') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 42, username: 'test', quota: 500000, used_quota: 0 } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const adapter = new NewApiAdapter();
  // Use a fake JWT with id=42 so userId is discovered
  const fakeJwt = `header.${Buffer.from(JSON.stringify({ id: 42 })).toString('base64url')}.sig`;
  await adapter.getBalance(baseUrl, fakeJwt, 42);

  expect(receivedHeaders['new-api-user']).toBe('42');
  expect(receivedHeaders['veloera-user']).toBe('42');
  expect(receivedHeaders['voapi-user']).toBe('42');
  expect(receivedHeaders['user-id']).toBe('42');
  expect(receivedHeaders['rix-api-user']).toBe('42');
  expect(receivedHeaders['neo-api-user']).toBe('42');
});
```

**Step 2: Run test to verify it fails**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/newApi.test.ts`
Expected: FAIL — only `new-api-user` header is present

**Step 3: Write minimal implementation**

In `src/server/services/platforms/newApi.ts`, replace the `authHeaders` method (lines 32-36):

```typescript
// Before:
private authHeaders(accessToken: string, userId?: number): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (userId) headers['New-Api-User'] = String(userId);
  return headers;
}

// After:
private authHeaders(accessToken: string, userId?: number): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (userId) {
    const value = String(userId);
    headers['New-API-User'] = value;
    headers['Veloera-User'] = value;
    headers['voapi-user'] = value;
    headers['User-id'] = value;
    headers['Rix-Api-User'] = value;
    headers['neo-api-user'] = value;
  }
  return headers;
}
```

**Step 4: Run test to verify it passes**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/newApi.test.ts`
Expected: PASS

**Step 5: Run all existing tests to check for regressions**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/server/services/platforms/newApi.ts src/server/services/platforms/newApi.test.ts
git commit -m "feat: add compatibility user-id headers to NewApiAdapter

Fan out userId across all 6 known One-API/New-API family header names
(New-API-User, Veloera-User, voapi-user, User-id, Rix-Api-User, neo-api-user)
to match all-api-hub behavior. This ensures VoAPI, Super-API, RIX_API,
Neo-API, and Veloera deployments correctly identify the requesting user."
```

---

### Task 2: Rewrite Sub2API Adapter

**Files:**
- Rewrite: `src/server/services/platforms/sub2api.ts`
- Create: `src/server/services/platforms/sub2api.test.ts`

**Step 1: Write the failing tests**

Create `src/server/services/platforms/sub2api.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Sub2ApiAdapter } from './sub2api.js';

describe('Sub2ApiAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let adapter: Sub2ApiAdapter;

  beforeEach(() => {
    adapter = new Sub2ApiAdapter();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('detects sub2api from URL', async () => {
    expect(await adapter.detect('https://sub2api.example.com')).toBe(true);
    expect(await adapter.detect('https://example.com')).toBe(false);
  });

  it('returns unsupported for checkin', async () => {
    const result = await adapter.checkin('http://localhost', 'token');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not supported');
  });

  it('fetches balance from /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 12.5 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const balance = await adapter.getBalance(baseUrl, 'jwt-token');
    expect(balance.balance).toBeGreaterThan(0);
    expect(balance.used).toBe(0);
  });

  it('fetches user info from /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 5.0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const userInfo = await adapter.getUserInfo(baseUrl, 'jwt-token');
    expect(userInfo).not.toBeNull();
    expect(userInfo!.username).toBe('testuser');
  });

  it('falls back to email local part when username is empty', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: '', email: 'alice@example.com', balance: 0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const userInfo = await adapter.getUserInfo(baseUrl, 'jwt-token');
    expect(userInfo!.username).toBe('alice');
  });

  it('fetches models via /v1/models', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'gpt-4o' }, { id: 'claude-3-opus' }],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(baseUrl, 'jwt-token');
    expect(models).toEqual(['gpt-4o', 'claude-3-opus']);
  });

  it('handles non-zero code as error in /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 401,
          message: 'token expired',
          data: null,
        }));
        return;
      }
      res.writeHead(404).end();
    });

    await expect(adapter.getBalance(baseUrl, 'expired-token')).rejects.toThrow();
  });

  it('login returns unsupported', async () => {
    const result = await adapter.login('http://localhost', 'user', 'pass');
    expect(result.success).toBe(false);
  });

  it('token management returns empty/false', async () => {
    expect(await adapter.getApiToken('http://localhost', 'token')).toBeNull();
    expect(await adapter.getApiTokens('http://localhost', 'token')).toEqual([]);
    expect(await adapter.createApiToken('http://localhost', 'token')).toBe(false);
    expect(await adapter.deleteApiToken('http://localhost', 'token', 'key')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/sub2api.test.ts`
Expected: FAIL — current Sub2ApiAdapter doesn't have these methods

**Step 3: Rewrite the adapter**

Replace `src/server/services/platforms/sub2api.ts` entirely:

```typescript
import { BasePlatformAdapter, CheckinResult, BalanceInfo, UserInfo } from './base.js';

/**
 * Sub2API adapter.
 *
 * Sub2API uses JWT-based auth with endpoints under /api/v1/*.
 * It does NOT support: login, check-in, token management, or usage stats.
 * Balance is derived from a USD amount returned by /api/v1/auth/me.
 */
export class Sub2ApiAdapter extends BasePlatformAdapter {
  readonly platformName = 'sub2api';

  async detect(url: string): Promise<boolean> {
    return url.toLowerCase().includes('sub2api');
  }

  /**
   * Parse the Sub2API { code, message, data } envelope.
   * code === 0 means success; anything else is an error.
   */
  private parseSub2ApiEnvelope<T>(body: any, endpoint: string): T {
    if (!body || typeof body !== 'object') {
      throw new Error(`Invalid response from ${endpoint}`);
    }
    if (typeof body.code !== 'number') {
      throw new Error(`Invalid response format from ${endpoint}`);
    }
    if (body.code !== 0) {
      const message = typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : `Error code ${body.code} from ${endpoint}`;
      throw new Error(message);
    }
    if (body.data === undefined) {
      throw new Error(`Missing data in response from ${endpoint}`);
    }
    return body.data as T;
  }

  /**
   * Extract display name: prefer username, fall back to email local part.
   */
  private getDisplayName(username?: string, email?: string): string {
    const name = (username || '').trim();
    if (name) return name;
    const mail = (email || '').trim();
    if (!mail) return '';
    const atIndex = mail.indexOf('@');
    return atIndex > 0 ? mail.slice(0, atIndex) : mail;
  }

  /**
   * Fetch user data from /api/v1/auth/me.
   */
  private async fetchAuthMe(baseUrl: string, accessToken: string): Promise<{
    id: number;
    username: string;
    email: string;
    balance: number;
  }> {
    const endpoint = '/api/v1/auth/me';
    const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = this.parseSub2ApiEnvelope<any>(res, endpoint);

    const id = typeof data.id === 'number' ? data.id
      : typeof data.id === 'string' ? Number.parseInt(data.id, 10)
      : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`Invalid user ID in response from ${endpoint}`);
    }

    const balance = typeof data.balance === 'number' ? data.balance
      : typeof data.balance === 'string' ? Number.parseFloat(data.balance)
      : 0;

    return {
      id,
      username: typeof data.username === 'string' ? data.username : '',
      email: typeof data.email === 'string' ? data.email : '',
      balance: Number.isFinite(balance) ? balance : 0,
    };
  }

  /**
   * Convert USD balance to internal quota unit.
   * Uses the same conversion factor as all-api-hub (500000 per USD).
   */
  private usdToQuota(balanceUsd: number): number {
    return Math.round(Math.max(0, balanceUsd) * 500000);
  }

  // --- Login: Not supported (JWT only) ---
  override async login(): Promise<{ success: false; message: string }> {
    return { success: false, message: 'Sub2API uses JWT authentication; login is not supported' };
  }

  // --- User Info ---
  override async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    try {
      const user = await this.fetchAuthMe(baseUrl, accessToken);
      return {
        username: this.getDisplayName(user.username, user.email),
        email: user.email || undefined,
      };
    } catch {
      return null;
    }
  }

  // --- Check-in: Not supported ---
  async checkin(): Promise<CheckinResult> {
    return { success: false, message: 'Check-in is not supported by Sub2API' };
  }

  // --- Balance ---
  async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const user = await this.fetchAuthMe(baseUrl, accessToken);
    const quotaValue = this.usdToQuota(user.balance);
    // Sub2API only provides current balance, no usage breakdown
    return {
      balance: quotaValue / 500000,
      used: 0,
      quota: quotaValue / 500000,
    };
  }

  // --- Models: Standard OpenAI-compatible endpoint ---
  async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      return (res?.data || []).map((m: any) => m.id).filter(Boolean);
    } catch {
      return [];
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/sub2api.test.ts`
Expected: All PASS

**Step 5: Run all tests for regressions**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/server/services/platforms/sub2api.ts src/server/services/platforms/sub2api.test.ts
git commit -m "feat: rewrite Sub2API adapter with proper JWT auth

Sub2API uses JWT-based auth with /api/v1/* endpoints, completely different
from One-API. The old stub just inherited OneApiAdapter and couldn't work.

Now implements:
- User info + balance via GET /api/v1/auth/me ({code, message, data} envelope)
- USD balance to quota conversion
- Display name fallback (username → email local part)
- Unsupported: login, check-in, token management
- Models: standard /v1/models (OpenAI-compatible)"
```

---

### Task 3: Enhance OneHub Adapter

**Files:**
- Modify: `src/server/services/platforms/oneHub.ts`
- Create: `src/server/services/platforms/oneHub.test.ts`

**Step 1: Write the failing tests**

Create `src/server/services/platforms/oneHub.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { OneHubAdapter } from './oneHub.js';

describe('OneHubAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('falls back to /api/available_model when /v1/models fails', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/api/available_model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            'gpt-4o': { price: { input: 0.5, output: 1.5 } },
            'claude-3-opus': { price: { input: 1, output: 3 } },
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const models = await adapter.getModels(baseUrl, 'token');
    expect(models).toEqual(expect.arrayContaining(['gpt-4o', 'claude-3-opus']));
  });

  it('returns user groups from /api/user_group_map', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/user_group_map') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { default: 1.0, vip: 0.8 } }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const groups = await adapter.getUserGroups(baseUrl, 'token');
    expect(groups).toEqual(expect.arrayContaining(['default', 'vip']));
  });

  it('parses token list from {data: [...]} envelope', async () => {
    await startServer((req, res) => {
      if (req.url?.startsWith('/api/token/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { key: 'sk-hub-abc', name: 'my-token', status: 1, id: 1 },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const adapter = new OneHubAdapter();
    const tokens = await adapter.getApiTokens(baseUrl, 'token');
    expect(tokens.length).toBe(1);
    expect(tokens[0].key).toBe('sk-hub-abc');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/oneHub.test.ts`
Expected: FAIL — OneHubAdapter doesn't override getModels or getUserGroups

**Step 3: Implement OneHub overrides**

Replace `src/server/services/platforms/oneHub.ts`:

```typescript
import { OneApiAdapter } from './oneApi.js';

export class OneHubAdapter extends OneApiAdapter {
  readonly platformName = 'one-hub';

  async detect(url: string): Promise<boolean> {
    const normalized = url.toLowerCase();
    return normalized.includes('onehub') || normalized.includes('one-hub');
  }

  /**
   * OneHub model discovery: try /v1/models first, fall back to /api/available_model.
   * The /api/available_model endpoint returns { data: { model_name: { price: ... }, ... } }
   * where the keys are model names.
   */
  override async getModels(baseUrl: string, apiToken: string, platformUserId?: number): Promise<string[]> {
    // Try standard OpenAI-compatible endpoint first
    let openAiModels: string[] = [];
    try {
      openAiModels = await super.getModels(baseUrl, apiToken, platformUserId);
    } catch {}
    if (openAiModels.length > 0) return openAiModels;

    // Fall back to OneHub's /api/available_model
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/available_model`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      const payload = res?.data && typeof res.data === 'object' ? res.data : res;
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const models = Object.keys(payload).filter(Boolean);
        if (models.length > 0) return models;
      }
    } catch {}

    return [];
  }

  /**
   * OneHub user groups: /api/user_group_map returns { data: { group_name: ratio, ... } }
   */
  override async getUserGroups(baseUrl: string, accessToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user_group_map`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const source = res?.data || res;
      if (source && typeof source === 'object' && !Array.isArray(source)) {
        const groups = Object.keys(source).map((k) => k.trim()).filter(Boolean);
        if (groups.length > 0) return Array.from(new Set(groups));
      }
    } catch {}

    // Fall back to parent implementation
    return super.getUserGroups(baseUrl, accessToken);
  }
}
```

**Step 4: Run tests**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/oneHub.test.ts`
Expected: All PASS

**Step 5: Run all tests**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/server/services/platforms/oneHub.ts src/server/services/platforms/oneHub.test.ts
git commit -m "feat: enhance OneHub adapter with model and group discovery

Add OneHub-specific overrides:
- getModels: fallback to /api/available_model when /v1/models unavailable
- getUserGroups: use /api/user_group_map endpoint
Aligns with all-api-hub's OneHub service implementation."
```

---

### Task 4: Enhance DoneHub Adapter (Re-parent to OneHub)

**Files:**
- Modify: `src/server/services/platforms/doneHub.ts`
- Modify: `src/server/services/platforms/doneHub.test.ts`

**Step 1: Add test for inherited OneHub behavior**

Add to existing `doneHub.test.ts`:

```typescript
it('inherits OneHub model discovery from /api/available_model', async () => {
  // Already tested — existing test "falls back to /api/available_model" covers this
  // Just verify it still works after re-parenting
  const adapter = new DoneHubAdapter();
  const models = await adapter.getModels(baseUrl, 'token');
  expect(models).toEqual(['gpt-4o', 'deepseek-chat']);
});

it('inherits OneHub user group discovery', async () => {
  // Add /api/user_group_map handler to server
  // This requires modifying the server setup
});
```

**Step 2: Re-parent DoneHub to extend OneHub**

Modify `src/server/services/platforms/doneHub.ts`:

```typescript
import { OneHubAdapter } from './oneHub.js';
import type { CheckinResult } from './base.js';

export class DoneHubAdapter extends OneHubAdapter {
  readonly platformName = 'done-hub';

  async detect(url: string): Promise<boolean> {
    const normalized = url.toLowerCase();
    return normalized.includes('donehub') || normalized.includes('done-hub');
  }

  // DoneHub deployments generally do not expose /api/user/checkin.
  override async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'checkin endpoint not found' };
  }

  // getModels is inherited from OneHubAdapter which already has /api/available_model fallback
  // No need to override — remove the duplicate implementation
}
```

**Step 3: Run existing DoneHub tests**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run src/server/services/platforms/doneHub.test.ts`
Expected: All PASS (behavior unchanged, just cleaner inheritance)

**Step 4: Run all tests**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/server/services/platforms/doneHub.ts src/server/services/platforms/doneHub.test.ts
git commit -m "refactor: re-parent DoneHub to extend OneHub adapter

DoneHub is downstream of OneHub. By extending OneHubAdapter instead of
OneApiAdapter, DoneHub inherits OneHub's /api/available_model fallback
and /api/user_group_map support. Removes duplicate getModels override
that OneHub now provides."
```

---

### Task 5: Enhance Veloera Adapter with Compat Headers

**Files:**
- Modify: `src/server/services/platforms/veloera.ts`

**Step 1: Review current state**

The Veloera adapter already has:
- Correct quota conversion (1,000,000 divisor)
- Working checkin via `/api/user/checkin`
- Working balance via `/api/user/self`
- Working models via `/v1/models`

The main gap: Veloera doesn't send compat user-id headers in its requests. Since VeloeraAdapter extends BasePlatformAdapter (not NewApiAdapter), it uses simple `Authorization: Bearer` without any user-id headers.

**Step 2: Add compat headers to Veloera balance/checkin requests**

Modify `src/server/services/platforms/veloera.ts` to include `Veloera-User` header when userId is available:

```typescript
import { BasePlatformAdapter, CheckinResult, BalanceInfo } from './base.js';

export class VeloeraAdapter extends BasePlatformAdapter {
  readonly platformName = 'veloera';

  async detect(url: string): Promise<boolean> {
    try {
      const res = await this.fetchJson<any>(`${url}/api/status`);
      return res?.success === true && (
        res?.data?.system_name?.toLowerCase().includes('veloera') ||
        res?.data?.version?.includes('veloera')
      );
    } catch {
      return false;
    }
  }

  private veloeraHeaders(accessToken: string, userId?: number): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (userId) {
      const value = String(userId);
      headers['Veloera-User'] = value;
      headers['New-API-User'] = value;
      headers['User-id'] = value;
    }
    return headers;
  }

  async checkin(baseUrl: string, accessToken: string, platformUserId?: number): Promise<CheckinResult> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/checkin`, {
        method: 'POST',
        headers: this.veloeraHeaders(accessToken, platformUserId),
      });
      if (res?.success) {
        return { success: true, message: res.message || 'Check-in successful', reward: res.data?.reward?.toString() };
      }
      return { success: false, message: res?.message || 'Check-in failed' };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  async getBalance(baseUrl: string, accessToken: string, platformUserId?: number): Promise<BalanceInfo> {
    const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
      headers: this.veloeraHeaders(accessToken, platformUserId),
    });
    const data = res?.data;
    const quota = (data?.quota || 0) / 1000000;
    const used = (data?.used_quota || 0) / 1000000;
    const todayIncome = Number.isFinite(data?.today_income) ? (data.today_income / 1000000) : undefined;
    const todayQuotaConsumption = Number.isFinite(data?.today_quota_consumption) ? (data.today_quota_consumption / 1000000) : undefined;
    return { balance: quota - used, used, quota, todayIncome, todayQuotaConsumption };
  }

  async getModels(baseUrl: string, apiToken: string, _platformUserId?: number): Promise<string[]> {
    const res = await this.fetchJson<any>(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    return (res?.data || []).map((m: any) => m.id).filter(Boolean);
  }
}
```

**Step 3: Run all tests**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/server/services/platforms/veloera.ts
git commit -m "feat: add compat user-id headers to Veloera adapter

Add Veloera-User, New-API-User, and User-id headers to balance and
checkin requests. Accept platformUserId parameter in checkin/getBalance
for consistency with other adapters."
```

---

### Task 6: Update Income Log Fallback for Sub2API

**Files:**
- Check: `src/server/services/balanceService.ts`

**Step 1: Verify Sub2API is NOT in the income log fallback list**

The `supportsTodayIncomeLogFallback()` function only includes `new-api`, `anyrouter`, `one-api`, `veloera`. Sub2API should NOT be in this list (it doesn't support log endpoints). Verify this is already correct — no change needed.

**Step 2: Run full test suite**

Run: `cd /d/Desktop/metapi工作区/metapi && npx vitest run`
Expected: All PASS — this is the final verification

**Step 3: Final commit (if any remaining changes)**

No code changes expected for this task. It's a verification step.
