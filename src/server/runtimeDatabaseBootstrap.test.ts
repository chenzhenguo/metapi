import { describe, expect, it, vi } from 'vitest';
import { ensureRuntimeDatabaseReady } from './runtimeDatabaseBootstrap.js';

describe('runtimeDatabaseBootstrap', () => {
  it('runs sqlite runtime migrations when dialect is sqlite', async () => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect: 'sqlite',
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(runSqliteRuntimeMigrations).toHaveBeenCalledTimes(1);
    expect(ensureExternalRuntimeSchema).not.toHaveBeenCalled();
  });

  it.each(['postgres', 'mysql'] as const)('bootstraps external schema when dialect is %s', async (dialect) => {
    const runSqliteRuntimeMigrations = vi.fn(async () => {});
    const ensureExternalRuntimeSchema = vi.fn(async () => {});

    await ensureRuntimeDatabaseReady({
      dialect,
      runSqliteRuntimeMigrations,
      ensureExternalRuntimeSchema,
    });

    expect(ensureExternalRuntimeSchema).toHaveBeenCalledTimes(1);
    expect(runSqliteRuntimeMigrations).not.toHaveBeenCalled();
  });
});
