import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ConfigModule = typeof import('../config.js');

describe('TokenRouter runtime cache', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalCacheTtlMs = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-cache-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    config = configModule.config;
    originalCacheTtlMs = config.tokenRouterCacheTtlMs;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    config.tokenRouterCacheTtlMs = 60_000;
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    config.tokenRouterCacheTtlMs = originalCacheTtlMs;
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('keeps route snapshot inside TTL until explicit invalidation', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cache-site',
      url: 'https://cache-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-user',
      accessToken: 'cache-access-token',
      apiToken: 'cache-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'cache-token',
      token: 'sk-cache-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    expect(await router.selectChannel('gpt-4o-mini')).toBeTruthy();

    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).run();
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run();

    const cachedSelection = await router.selectChannel('gpt-4o-mini');
    expect(cachedSelection).toBeTruthy();

    invalidateTokenRouterCache();
    const refreshedSelection = await router.selectChannel('gpt-4o-mini');
    expect(refreshedSelection).toBeNull();
  });

  it('uses fibonacci-style cooldown across repeated failures', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cooldown-site',
      url: 'https://cooldown-site.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cooldown-user',
      accessToken: 'cooldown-access-token',
      apiToken: 'cooldown-api-token',
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'cooldown-token',
      token: 'sk-cooldown-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();

    const firstStartedAt = Date.now();
    await router.recordFailure(channel.id);
    const firstRecord = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const firstCooldownMs = Date.parse(String(firstRecord?.cooldownUntil || '')) - firstStartedAt;
    expect(firstCooldownMs).toBeGreaterThanOrEqual(10_000);
    expect(firstCooldownMs).toBeLessThanOrEqual(20_000);

    const secondStartedAt = Date.now();
    await router.recordFailure(channel.id);
    const secondRecord = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const secondCooldownMs = Date.parse(String(secondRecord?.cooldownUntil || '')) - secondStartedAt;
    expect(secondCooldownMs).toBeGreaterThanOrEqual(10_000);
    expect(secondCooldownMs).toBeLessThanOrEqual(20_000);

    const thirdStartedAt = Date.now();
    await router.recordFailure(channel.id);
    const thirdRecord = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    const thirdCooldownMs = Date.parse(String(thirdRecord?.cooldownUntil || '')) - thirdStartedAt;
    expect(thirdCooldownMs).toBeGreaterThanOrEqual(25_000);
    expect(thirdCooldownMs).toBeLessThanOrEqual(35_000);
  });
});
