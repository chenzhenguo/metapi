import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureSiteSchemaCompatibility, type SiteSchemaInspector } from './siteSchemaCompatibility.js';
import { ensureRouteGroupingSchemaCompatibility } from './routeGroupingSchemaCompatibility.js';
import { ensureProxyFileSchemaCompatibility } from './proxyFileSchemaCompatibility.js';

export type RuntimeSchemaDialect = 'sqlite' | 'mysql' | 'postgres';

export interface RuntimeSchemaClient {
  dialect: RuntimeSchemaDialect;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  execute(sqlText: string, params?: unknown[]): Promise<unknown>;
  queryScalar(sqlText: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export interface RuntimeSchemaConnectionInput {
  dialect: RuntimeSchemaDialect;
  connectionString: string;
  ssl?: boolean;
}

function validateIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return identifier;
}

function createSiteSchemaInspector(client: RuntimeSchemaClient): SiteSchemaInspector {
  if (client.dialect === 'sqlite') {
    return {
      dialect: 'sqlite',
      tableExists: async (table) => {
        const normalizedTable = validateIdentifier(table);
        return (await client.queryScalar(
          `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${normalizedTable}'`,
        )) > 0;
      },
      columnExists: async (table, column) => {
        const normalizedTable = validateIdentifier(table);
        const normalizedColumn = validateIdentifier(column);
        return (await client.queryScalar(
          `SELECT COUNT(*) FROM pragma_table_info('${normalizedTable}') WHERE name = '${normalizedColumn}'`,
        )) > 0;
      },
      execute: async (sqlText) => {
        await client.execute(sqlText);
      },
    };
  }

  if (client.dialect === 'mysql') {
    return {
      dialect: 'mysql',
      tableExists: async (table) => {
        return (await client.queryScalar(
          'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
          [table],
        )) > 0;
      },
      columnExists: async (table, column) => {
        return (await client.queryScalar(
          'SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
          [table, column],
        )) > 0;
      },
      execute: async (sqlText) => {
        await client.execute(sqlText);
      },
    };
  }

  return {
    dialect: 'postgres',
    tableExists: async (table) => {
      return (await client.queryScalar(
        'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
        [table],
      )) > 0;
    },
    columnExists: async (table, column) => {
      return (await client.queryScalar(
        'SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
        [table, column],
      )) > 0;
    },
    execute: async (sqlText) => {
      await client.execute(sqlText);
    },
  };
}

async function createPostgresClient(connectionString: string, ssl: boolean): Promise<RuntimeSchemaClient> {
  const clientOptions: pg.ClientConfig = { connectionString };
  if (ssl) {
    clientOptions.ssl = { rejectUnauthorized: false };
  }
  const client = new pg.Client(clientOptions);
  await client.connect();

  return {
    dialect: 'postgres',
    begin: async () => { await client.query('BEGIN'); },
    commit: async () => { await client.query('COMMIT'); },
    rollback: async () => { await client.query('ROLLBACK'); },
    execute: async (sqlText, params = []) => client.query(sqlText, params),
    queryScalar: async (sqlText, params = []) => {
      const result = await client.query(sqlText, params);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return 0;
      return Number(Object.values(row)[0]) || 0;
    },
    close: async () => { await client.end(); },
  };
}

async function createMySqlClient(connectionString: string, ssl: boolean): Promise<RuntimeSchemaClient> {
  const connectionOptions: mysql.ConnectionOptions = { uri: connectionString };
  if (ssl) {
    connectionOptions.ssl = { rejectUnauthorized: false };
  }
  const connection = await mysql.createConnection(connectionOptions);

  return {
    dialect: 'mysql',
    begin: async () => { await connection.beginTransaction(); },
    commit: async () => { await connection.commit(); },
    rollback: async () => { await connection.rollback(); },
    execute: async (sqlText, params = []) => connection.execute(sqlText, params as any[]),
    queryScalar: async (sqlText, params = []) => {
      const [rows] = await connection.query(sqlText, params as any[]);
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      const row = rows[0] as Record<string, unknown>;
      return Number(Object.values(row)[0]) || 0;
    },
    close: async () => { await connection.end(); },
  };
}

async function createSqliteClient(connectionString: string): Promise<RuntimeSchemaClient> {
  const filePath = connectionString === ':memory:' ? ':memory:' : resolve(connectionString);
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return {
    dialect: 'sqlite',
    begin: async () => { sqlite.exec('BEGIN'); },
    commit: async () => { sqlite.exec('COMMIT'); },
    rollback: async () => { sqlite.exec('ROLLBACK'); },
    execute: async (sqlText, params = []) => {
      const lowered = sqlText.trim().toLowerCase();
      const statement = sqlite.prepare(sqlText);
      if (lowered.startsWith('select')) return statement.all(...params);
      return statement.run(...params);
    },
    queryScalar: async (sqlText, params = []) => {
      const row = sqlite.prepare(sqlText).get(...params) as Record<string, unknown> | undefined;
      if (!row) return 0;
      return Number(Object.values(row)[0]) || 0;
    },
    close: async () => { sqlite.close(); },
  };
}

export async function createRuntimeSchemaClient(input: RuntimeSchemaConnectionInput): Promise<RuntimeSchemaClient> {
  if (input.dialect === 'postgres') {
    return createPostgresClient(input.connectionString, !!input.ssl);
  }
  if (input.dialect === 'mysql') {
    return createMySqlClient(input.connectionString, !!input.ssl);
  }
  return createSqliteClient(input.connectionString);
}

export async function ensureRuntimeDatabaseSchema(client: RuntimeSchemaClient): Promise<void> {
  const statements = client.dialect === 'postgres'
    ? [
      `CREATE TABLE IF NOT EXISTS "sites" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "external_checkin_url" TEXT, "platform" TEXT NOT NULL, "proxy_url" TEXT, "use_system_proxy" BOOLEAN DEFAULT FALSE, "status" TEXT DEFAULT 'active', "is_pinned" BOOLEAN DEFAULT FALSE, "sort_order" INTEGER DEFAULT 0, "global_weight" DOUBLE PRECISION DEFAULT 1, "api_key" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "accounts" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "username" TEXT, "access_token" TEXT NOT NULL, "api_token" TEXT, "balance" DOUBLE PRECISION DEFAULT 0, "balance_used" DOUBLE PRECISION DEFAULT 0, "quota" DOUBLE PRECISION DEFAULT 0, "unit_cost" DOUBLE PRECISION, "value_score" DOUBLE PRECISION DEFAULT 0, "status" TEXT DEFAULT 'active', "is_pinned" BOOLEAN DEFAULT FALSE, "sort_order" INTEGER DEFAULT 0, "checkin_enabled" BOOLEAN DEFAULT TRUE, "last_checkin_at" TEXT, "last_balance_refresh" TEXT, "extra_config" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "account_tokens" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "token" TEXT NOT NULL, "token_group" TEXT, "source" TEXT DEFAULT 'manual', "enabled" BOOLEAN DEFAULT TRUE, "is_default" BOOLEAN DEFAULT FALSE, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "checkin_logs" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "status" TEXT NOT NULL, "message" TEXT, "reward" TEXT, "created_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "model_availability" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" BOOLEAN, "latency_ms" INTEGER, "checked_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "token_model_availability" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "token_id" INTEGER NOT NULL REFERENCES "account_tokens"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" BOOLEAN, "latency_ms" INTEGER, "checked_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "token_routes" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "model_pattern" TEXT NOT NULL, "display_name" TEXT, "display_icon" TEXT, "model_mapping" TEXT, "decision_snapshot" TEXT, "decision_refreshed_at" TEXT, "enabled" BOOLEAN DEFAULT TRUE, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "route_channels" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "route_id" INTEGER NOT NULL REFERENCES "token_routes"("id") ON DELETE CASCADE, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "token_id" INTEGER REFERENCES "account_tokens"("id") ON DELETE SET NULL, "source_model" TEXT, "priority" INTEGER DEFAULT 0, "weight" INTEGER DEFAULT 10, "enabled" BOOLEAN DEFAULT TRUE, "manual_override" BOOLEAN DEFAULT FALSE, "success_count" INTEGER DEFAULT 0, "fail_count" INTEGER DEFAULT 0, "total_latency_ms" INTEGER DEFAULT 0, "total_cost" DOUBLE PRECISION DEFAULT 0, "last_used_at" TEXT, "last_fail_at" TEXT, "cooldown_until" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "proxy_logs" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "route_id" INTEGER, "channel_id" INTEGER, "account_id" INTEGER, "model_requested" TEXT, "model_actual" TEXT, "status" TEXT, "http_status" INTEGER, "latency_ms" INTEGER, "prompt_tokens" INTEGER, "completion_tokens" INTEGER, "total_tokens" INTEGER, "estimated_cost" DOUBLE PRECISION, "billing_details" TEXT, "error_message" TEXT, "retry_count" INTEGER DEFAULT 0, "created_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "proxy_video_tasks" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "public_id" TEXT NOT NULL UNIQUE, "upstream_video_id" TEXT NOT NULL, "site_url" TEXT NOT NULL, "token_value" TEXT NOT NULL, "requested_model" TEXT, "actual_model" TEXT, "channel_id" INTEGER, "account_id" INTEGER, "status_snapshot" TEXT, "upstream_response_meta" TEXT, "last_upstream_status" INTEGER, "last_polled_at" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "proxy_files" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "public_id" TEXT NOT NULL UNIQUE, "owner_type" TEXT NOT NULL, "owner_id" TEXT NOT NULL, "filename" TEXT NOT NULL, "mime_type" TEXT NOT NULL, "purpose" TEXT, "byte_size" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "content_base64" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "downstream_api_keys" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "name" TEXT NOT NULL, "key" TEXT NOT NULL UNIQUE, "description" TEXT, "enabled" BOOLEAN DEFAULT TRUE, "expires_at" TEXT, "max_cost" DOUBLE PRECISION, "used_cost" DOUBLE PRECISION DEFAULT 0, "max_requests" INTEGER, "used_requests" INTEGER DEFAULT 0, "supported_models" TEXT, "allowed_route_ids" TEXT, "site_weight_multipliers" TEXT, "last_used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "events" ("id" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "message" TEXT, "level" TEXT DEFAULT 'info', "read" BOOLEAN DEFAULT FALSE, "related_id" INTEGER, "related_type" TEXT, "created_at" TEXT)`,
      `CREATE TABLE IF NOT EXISTS "settings" ("key" TEXT PRIMARY KEY, "value" TEXT)`,
    ]
    : client.dialect === 'mysql'
      ? [
        `CREATE TABLE IF NOT EXISTS \`sites\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`name\` TEXT NOT NULL, \`url\` TEXT NOT NULL, \`external_checkin_url\` TEXT NULL, \`platform\` VARCHAR(64) NOT NULL, \`proxy_url\` TEXT NULL, \`use_system_proxy\` BOOLEAN DEFAULT FALSE, \`status\` VARCHAR(32) DEFAULT 'active', \`is_pinned\` BOOLEAN DEFAULT FALSE, \`sort_order\` INT DEFAULT 0, \`global_weight\` DOUBLE DEFAULT 1, \`api_key\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`accounts\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`site_id\` INT NOT NULL, \`username\` TEXT NULL, \`access_token\` TEXT NOT NULL, \`api_token\` TEXT NULL, \`balance\` DOUBLE DEFAULT 0, \`balance_used\` DOUBLE DEFAULT 0, \`quota\` DOUBLE DEFAULT 0, \`unit_cost\` DOUBLE NULL, \`value_score\` DOUBLE DEFAULT 0, \`status\` VARCHAR(32) DEFAULT 'active', \`is_pinned\` BOOLEAN DEFAULT FALSE, \`sort_order\` INT DEFAULT 0, \`checkin_enabled\` BOOLEAN DEFAULT TRUE, \`last_checkin_at\` TEXT NULL, \`last_balance_refresh\` TEXT NULL, \`extra_config\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL, CONSTRAINT \`accounts_site_fk\` FOREIGN KEY (\`site_id\`) REFERENCES \`sites\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`account_tokens\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`account_id\` INT NOT NULL, \`name\` TEXT NOT NULL, \`token\` TEXT NOT NULL, \`token_group\` TEXT NULL, \`source\` VARCHAR(32) DEFAULT 'manual', \`enabled\` BOOLEAN DEFAULT TRUE, \`is_default\` BOOLEAN DEFAULT FALSE, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL, CONSTRAINT \`account_tokens_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`checkin_logs\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`account_id\` INT NOT NULL, \`status\` VARCHAR(32) NOT NULL, \`message\` TEXT NULL, \`reward\` TEXT NULL, \`created_at\` TEXT NULL, CONSTRAINT \`checkin_logs_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`model_availability\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`account_id\` INT NOT NULL, \`model_name\` TEXT NOT NULL, \`available\` BOOLEAN NULL, \`latency_ms\` INT NULL, \`checked_at\` TEXT NULL, CONSTRAINT \`model_availability_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`token_model_availability\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`token_id\` INT NOT NULL, \`model_name\` TEXT NOT NULL, \`available\` BOOLEAN NULL, \`latency_ms\` INT NULL, \`checked_at\` TEXT NULL, CONSTRAINT \`token_model_availability_token_fk\` FOREIGN KEY (\`token_id\`) REFERENCES \`account_tokens\`(\`id\`) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS \`token_routes\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`model_pattern\` TEXT NOT NULL, \`display_name\` TEXT NULL, \`display_icon\` TEXT NULL, \`model_mapping\` TEXT NULL, \`decision_snapshot\` TEXT NULL, \`decision_refreshed_at\` TEXT NULL, \`enabled\` BOOLEAN DEFAULT TRUE, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`route_channels\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`route_id\` INT NOT NULL, \`account_id\` INT NOT NULL, \`token_id\` INT NULL, \`source_model\` TEXT NULL, \`priority\` INT DEFAULT 0, \`weight\` INT DEFAULT 10, \`enabled\` BOOLEAN DEFAULT TRUE, \`manual_override\` BOOLEAN DEFAULT FALSE, \`success_count\` INT DEFAULT 0, \`fail_count\` INT DEFAULT 0, \`total_latency_ms\` INT DEFAULT 0, \`total_cost\` DOUBLE DEFAULT 0, \`last_used_at\` TEXT NULL, \`last_fail_at\` TEXT NULL, \`cooldown_until\` TEXT NULL, CONSTRAINT \`route_channels_route_fk\` FOREIGN KEY (\`route_id\`) REFERENCES \`token_routes\`(\`id\`) ON DELETE CASCADE, CONSTRAINT \`route_channels_account_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE, CONSTRAINT \`route_channels_token_fk\` FOREIGN KEY (\`token_id\`) REFERENCES \`account_tokens\`(\`id\`) ON DELETE SET NULL)`,
        `CREATE TABLE IF NOT EXISTS \`proxy_logs\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`route_id\` INT NULL, \`channel_id\` INT NULL, \`account_id\` INT NULL, \`model_requested\` TEXT NULL, \`model_actual\` TEXT NULL, \`status\` VARCHAR(32) NULL, \`http_status\` INT NULL, \`latency_ms\` INT NULL, \`prompt_tokens\` INT NULL, \`completion_tokens\` INT NULL, \`total_tokens\` INT NULL, \`estimated_cost\` DOUBLE NULL, \`billing_details\` TEXT NULL, \`error_message\` TEXT NULL, \`retry_count\` INT DEFAULT 0, \`created_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`proxy_video_tasks\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`public_id\` VARCHAR(191) NOT NULL UNIQUE, \`upstream_video_id\` TEXT NOT NULL, \`site_url\` TEXT NOT NULL, \`token_value\` TEXT NOT NULL, \`requested_model\` TEXT NULL, \`actual_model\` TEXT NULL, \`channel_id\` INT NULL, \`account_id\` INT NULL, \`status_snapshot\` TEXT NULL, \`upstream_response_meta\` TEXT NULL, \`last_upstream_status\` INT NULL, \`last_polled_at\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`proxy_files\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`public_id\` VARCHAR(191) NOT NULL UNIQUE, \`owner_type\` VARCHAR(64) NOT NULL, \`owner_id\` VARCHAR(191) NOT NULL, \`filename\` TEXT NOT NULL, \`mime_type\` VARCHAR(191) NOT NULL, \`purpose\` TEXT NULL, \`byte_size\` INT NOT NULL, \`sha256\` VARCHAR(191) NOT NULL, \`content_base64\` LONGTEXT NOT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL, \`deleted_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`downstream_api_keys\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`name\` TEXT NOT NULL, \`key\` VARCHAR(191) NOT NULL UNIQUE, \`description\` TEXT NULL, \`enabled\` BOOLEAN DEFAULT TRUE, \`expires_at\` TEXT NULL, \`max_cost\` DOUBLE NULL, \`used_cost\` DOUBLE DEFAULT 0, \`max_requests\` INT NULL, \`used_requests\` INT DEFAULT 0, \`supported_models\` TEXT NULL, \`allowed_route_ids\` TEXT NULL, \`site_weight_multipliers\` TEXT NULL, \`last_used_at\` TEXT NULL, \`created_at\` TEXT NULL, \`updated_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`events\` (\`id\` INT AUTO_INCREMENT PRIMARY KEY, \`type\` VARCHAR(32) NOT NULL, \`title\` TEXT NOT NULL, \`message\` TEXT NULL, \`level\` VARCHAR(16) DEFAULT 'info', \`read\` BOOLEAN DEFAULT FALSE, \`related_id\` INT NULL, \`related_type\` VARCHAR(32) NULL, \`created_at\` TEXT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`settings\` (\`key\` VARCHAR(191) PRIMARY KEY, \`value\` TEXT NULL)`,
      ]
      : [
        `CREATE TABLE IF NOT EXISTS "sites" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "url" TEXT NOT NULL, "external_checkin_url" TEXT, "platform" TEXT NOT NULL, "proxy_url" TEXT, "use_system_proxy" INTEGER DEFAULT 0, "status" TEXT DEFAULT 'active', "is_pinned" INTEGER DEFAULT 0, "sort_order" INTEGER DEFAULT 0, "global_weight" REAL DEFAULT 1, "api_key" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "accounts" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "site_id" INTEGER NOT NULL REFERENCES "sites"("id") ON DELETE CASCADE, "username" TEXT, "access_token" TEXT NOT NULL, "api_token" TEXT, "balance" REAL DEFAULT 0, "balance_used" REAL DEFAULT 0, "quota" REAL DEFAULT 0, "unit_cost" REAL, "value_score" REAL DEFAULT 0, "status" TEXT DEFAULT 'active', "is_pinned" INTEGER DEFAULT 0, "sort_order" INTEGER DEFAULT 0, "checkin_enabled" INTEGER DEFAULT 1, "last_checkin_at" TEXT, "last_balance_refresh" TEXT, "extra_config" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "account_tokens" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "token" TEXT NOT NULL, "token_group" TEXT, "source" TEXT DEFAULT 'manual', "enabled" INTEGER DEFAULT 1, "is_default" INTEGER DEFAULT 0, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "checkin_logs" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "status" TEXT NOT NULL, "message" TEXT, "reward" TEXT, "created_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "model_availability" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" INTEGER, "latency_ms" INTEGER, "checked_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "token_model_availability" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "token_id" INTEGER NOT NULL REFERENCES "account_tokens"("id") ON DELETE CASCADE, "model_name" TEXT NOT NULL, "available" INTEGER, "latency_ms" INTEGER, "checked_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "token_routes" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "model_pattern" TEXT NOT NULL, "display_name" TEXT, "display_icon" TEXT, "model_mapping" TEXT, "decision_snapshot" TEXT, "decision_refreshed_at" TEXT, "enabled" INTEGER DEFAULT 1, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "route_channels" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "route_id" INTEGER NOT NULL REFERENCES "token_routes"("id") ON DELETE CASCADE, "account_id" INTEGER NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE, "token_id" INTEGER REFERENCES "account_tokens"("id") ON DELETE SET NULL, "source_model" TEXT, "priority" INTEGER DEFAULT 0, "weight" INTEGER DEFAULT 10, "enabled" INTEGER DEFAULT 1, "manual_override" INTEGER DEFAULT 0, "success_count" INTEGER DEFAULT 0, "fail_count" INTEGER DEFAULT 0, "total_latency_ms" INTEGER DEFAULT 0, "total_cost" REAL DEFAULT 0, "last_used_at" TEXT, "last_fail_at" TEXT, "cooldown_until" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "proxy_logs" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "route_id" INTEGER, "channel_id" INTEGER, "account_id" INTEGER, "model_requested" TEXT, "model_actual" TEXT, "status" TEXT, "http_status" INTEGER, "latency_ms" INTEGER, "prompt_tokens" INTEGER, "completion_tokens" INTEGER, "total_tokens" INTEGER, "estimated_cost" REAL, "billing_details" TEXT, "error_message" TEXT, "retry_count" INTEGER DEFAULT 0, "created_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "proxy_video_tasks" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "public_id" TEXT NOT NULL UNIQUE, "upstream_video_id" TEXT NOT NULL, "site_url" TEXT NOT NULL, "token_value" TEXT NOT NULL, "requested_model" TEXT, "actual_model" TEXT, "channel_id" INTEGER, "account_id" INTEGER, "status_snapshot" TEXT, "upstream_response_meta" TEXT, "last_upstream_status" INTEGER, "last_polled_at" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "proxy_files" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "public_id" TEXT NOT NULL UNIQUE, "owner_type" TEXT NOT NULL, "owner_id" TEXT NOT NULL, "filename" TEXT NOT NULL, "mime_type" TEXT NOT NULL, "purpose" TEXT, "byte_size" INTEGER NOT NULL, "sha256" TEXT NOT NULL, "content_base64" TEXT NOT NULL, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "downstream_api_keys" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "key" TEXT NOT NULL UNIQUE, "description" TEXT, "enabled" INTEGER DEFAULT 1, "expires_at" TEXT, "max_cost" REAL, "used_cost" REAL DEFAULT 0, "max_requests" INTEGER, "used_requests" INTEGER DEFAULT 0, "supported_models" TEXT, "allowed_route_ids" TEXT, "site_weight_multipliers" TEXT, "last_used_at" TEXT, "created_at" TEXT, "updated_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "events" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "message" TEXT, "level" TEXT DEFAULT 'info', "read" INTEGER DEFAULT 0, "related_id" INTEGER, "related_type" TEXT, "created_at" TEXT)`,
        `CREATE TABLE IF NOT EXISTS "settings" ("key" TEXT PRIMARY KEY, "value" TEXT)`,
      ];

  for (const sqlText of statements) {
    await client.execute(sqlText);
  }

  await ensureSiteSchemaCompatibility(createSiteSchemaInspector(client));
  await ensureRouteGroupingSchemaCompatibility(createSiteSchemaInspector(client));
  await ensureProxyFileSchemaCompatibility(createSiteSchemaInspector(client));
}

export async function bootstrapRuntimeDatabaseSchema(input: RuntimeSchemaConnectionInput): Promise<void> {
  const client = await createRuntimeSchemaClient(input);
  try {
    await ensureRuntimeDatabaseSchema(client);
  } finally {
    await client.close();
  }
}
