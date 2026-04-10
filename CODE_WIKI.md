# Metapi Code Wiki

## 项目概述

**Metapi** 是一个 AI 中转站的元聚合层（Meta-Aggregation Layer），将分散的 AI API 聚合平台（如 New API、One API、OneHub 等）统一为一个网关。

- **项目版本**: 1.3.0
- **主要语言**: TypeScript
- **Node.js 要求**: >=25.0.0
- **许可证**: MIT

---

## 目录结构

```
metapi/
├── build/                # 打包静态资源
├── data/                 # 默认运行时数据目录
├── dist/                 # 构建产物
├── docker/               # Docker 配置
├── docs/                 # VitePress 文档
├── drizzle/              # Drizzle SQL 迁移
├── scripts/              # 开发和打包脚本
├── src/
│   ├── desktop/          # Electron 主进程
│   ├── server/           # Fastify 服务端
│   └── web/              # React 管理后台
└── package.json
```

### 核心源码目录

#### `src/server/` - 服务端核心
- [index.ts](file:///workspace/src/server/index.ts) - Fastify 服务启动和初始化
- [config.ts](file:///workspace/src/server/config.ts) - 环境变量解析和配置
- `db/` - 数据库 Schema、连接和迁移
- `middleware/` - 认证等中间件
- `routes/` - API 路由和代理路由
- `services/` - 业务服务层
- `transformers/` - 协议转换层
- `proxy-core/` - 代理核心逻辑

#### `src/web/` - Web 前端
- [main.tsx](file:///workspace/src/web/main.tsx) - Vite 入口
- [App.tsx](file:///workspace/src/web/App.tsx) - 路由和页面装配
- `components/` - 通用组件
- `pages/` - 路由页面

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端框架 | Fastify 5.x |
| 前端框架 | React 18 + Vite |
| 数据库 ORM | Drizzle ORM |
| 数据库 | SQLite (默认) / MySQL / PostgreSQL |
| 样式 | Tailwind CSS v4 |
| 数据可视化 | VChart |
| 定时任务 | node-cron |
| 测试 | Vitest |

---

## 整体架构

### 三层架构

```
┌─────────────────────────────────────────┐
│           Web 前端 (React)              │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│         Fastify API Gateway             │
│  ┌───────────────────────────────────┐ │
│  │  管理 API (sites/accounts/tokens) │ │
│  └───────────────────────────────────┘ │
│  ┌───────────────────────────────────┐ │
│  │  代理路由 (/v1/*)                 │ │
│  └───────────────────────────────────┘ │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│         业务服务层                       │
│  - 平台适配器 (New API/One API 等)    │
│  - 模型可用性探测                       │
│  - 智能路由引擎                         │
│  - 签到/余额刷新                        │
└────────────────────┬────────────────────┘
                     │
┌────────────────────▼────────────────────┐
│         数据存储层                       │
│  SQLite/MySQL/PostgreSQL + Drizzle ORM │
└─────────────────────────────────────────┘
```

### 核心数据流

1. **客户端请求** → 代理路由 `/v1/*`
2. **Token 认证** → 下游 API Key 验证
3. **路由选择** → TokenRouter 根据模型、成本、余额选择最佳通道
4. **协议转换** → Transformers 层处理 OpenAI/Claude/Gemini 格式互转
5. **上游请求** → Platform Adapters 发送到对应平台
6. **响应返回** → 经过转换返回给客户端

---

## 核心模块详解

### 1. 配置模块 ([config.ts](file:///workspace/src/server/config.ts))

**主要功能**: 解析环境变量并构建运行时配置

**关键配置项**:

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `authToken` | change-me-admin-token | 管理后台令牌 |
| `proxyToken` | change-me-proxy-sk-token | 代理令牌 |
| `port` | 4000 | 服务端口 |
| `modelAvailabilityProbeEnabled` | false | 批量测活启用开关 |
| `modelAvailabilityProbeIntervalMs` | 1800000 (30分钟) | 测活间隔 |
| `modelAvailabilityProbeTimeoutMs` | 15000 (15秒) | 单次探测超时 |
| `modelAvailabilityProbeConcurrency` | 1 | 探测并发数 (1-16) |

### 2. 数据库模块 ([db/schema.ts](file:///workspace/src/server/db/schema.ts))

**主要表结构**:

#### 核心业务表

| 表名 | 说明 |
|------|------|
| `sites` | 上游站点配置 |
| `accounts` | 站点账号 |
| `accountTokens` | 账号 API Token |
| `modelAvailability` | 账号级模型可用性 |
| `tokenModelAvailability` | Token 级模型可用性 |
| `tokenRoutes` | Token 路由配置 |
| `routeChannels` | 路由通道 |
| `proxyLogs` | 代理请求日志 |

#### 关键表详解

##### `sites` 表
```typescript
{
  id: number;
  name: string;
  url: string;
  platform: string; // 'new-api' | 'one-api' | 'one-hub' | ...
  status: 'active' | 'disabled';
  proxyUrl?: string;
  customHeaders?: string; // JSON
}
```

##### `accounts` 表
```typescript
{
  id: number;
  siteId: number;
  username?: string;
  accessToken: string;
  apiToken?: string;
  balance: number;
  status: 'active' | 'disabled' | 'expired';
  checkinEnabled: boolean;
}
```

##### `modelAvailability` 表
```typescript
{
  id: number;
  accountId: number;
  modelName: string;
  available?: boolean;
  isManual: boolean;
  latencyMs?: number;
  checkedAt: string;
}
```

### 3. 批量测活功能核心

#### 核心服务: [modelAvailabilityProbeService.ts](file:///workspace/src/server/services/modelAvailabilityProbeService.ts)

**核心流程**:

1. **定时调度** - 每 30 分钟（可配置）触发一次
2. **账号遍历** - 获取所有活跃账号，按 Lease 机制避免重复探测
3. **目标加载** - 加载 `modelAvailability` 和 `tokenModelAvailability` 表中待测模型
4. **并发探测** - 使用 `mapWithConcurrency` 控制并发数（默认 1，最大 16）
5. **结果判定** - 根据响应状态码和错误信息判定 supported/unsupported/inconclusive/skipped
6. **路由重建** - 可用性变化时触发 `rebuildRoutesOnly()`

**关键防护机制**:

| 机制 | 实现 | 说明 |
|------|------|------|
| Lease 机制 | `probeAccountLeases` Set | 防止同一账号并发探测 |
| 超时控制 | 15 秒 + AbortController | 中断超时请求 |
| 模型过滤 | `NON_CONVERSATION_MODEL_PATTERNS` | 跳过 embedding/rerank/moderation/whisper/tts 等 |
| 确认弹窗 | 首次开启必须手打确认语句 | 风险提示 |

**探测状态类型**:
```typescript
type ProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';
```

**关键函数**:

- `executeModelAvailabilityProbe()` - 执行批量测活
- `probeSingleTarget()` - 探测单个模型
- `startModelAvailabilityProbeScheduler()` - 启动定时调度
- `queueModelAvailabilityProbeTask()` - 队列后台任务

#### 运行时探测: [runtimeModelProbe.ts](file:///workspace/src/server/services/runtimeModelProbe.ts)

**核心函数**: `probeRuntimeModel()`

**探测流程**:
1. 检查是否为对话模型（跳过非对话模型）
2. 构建探测请求体（`{"model": "...", "messages": [...], "max_tokens": 8}`）
3. 解析上游端点候选
4. 执行探测请求
5. 根据响应判定状态:
   - **supported**: 请求成功
   - **unsupported**: 400/403/404/422 + 错误模式匹配
   - **inconclusive**: 其他失败情况
   - **skipped**: 非对话模型

**不支持模式匹配**:
```typescript
const DEFINITE_UNSUPPORTED_PATTERNS = [
  /no such model/i,
  /unknown model/i,
  /模型.*(不存在|不可用|不支持)/,
  /(不存在|不可用|不支持).*模型/,
  /model.*(access denied|permission|forbidden)/i,
];
```

#### 确认语句与风险提示

**确认语句**:
```
我确认我使用的中转站全部允许批量测活，如因开启此功能被中转站封号，自行负责。
```

**风险提示**: 可能被部分中转站视为批量测活或异常行为，请务必先确认你的中转站明确允许此类探测

### 4. 智能路由引擎

#### 核心服务: [tokenRouter.ts](file:///workspace/src/server/services/tokenRouter.ts)

**路由策略**:

1. **四级成本信号**: 实测成本 → 账号配置成本 → 目录参考价 → 默认兜底
2. **多通道加权分配**: 成本(40%) + 余额(30%) + 使用率(30%)
3. **失败冷却**: 失败通道自动冷却（默认 10 分钟）
4. **自动重试**: 请求失败自动切换其他通道

**路由决策流程**:
```
请求 → 模型匹配 → 候选通道筛选 → 
  - 排除冷却通道
  - 排除禁用通道
  - 排除不可用模型
→ 加权排序 → 概率选择 → 执行请求
```

### 5. 代理核心 ([proxy-core/](file:///workspace/src/server/proxy-core/))

#### 主要组件:

| 组件 | 说明 |
|------|------|
| `conductor/` | 代理指挥器，控制重试和流转 |
| `executors/` | 上游执行器（Claude/Codex/Gemini 等） |
| `providers/` | 平台提供者配置 |
| `surfaces/` | 协议表面层（Chat/Models/Files 等） |
| `transformers/` | 协议转换层 |

#### 协议转换 ([transformers/](file:///workspace/src/server/transformers/))

支持的协议:
- OpenAI (Chat Completions, Responses, Embeddings, Images, Files)
- Claude (Messages API)
- Gemini (Generate Content API)

### 6. 平台适配器 ([services/platforms/](file:///workspace/src/server/services/platforms/))

支持的平台:

| 平台 | 适配器文件 |
|------|-----------|
| New API | [newApi.ts](file:///workspace/src/server/services/platforms/newApi.ts) |
| One API | [oneApi.ts](file:///workspace/src/server/services/platforms/oneApi.ts) |
| OneHub | [oneHub.ts](file:///workspace/src/server/services/platforms/oneHub.ts) |
| DoneHub | [doneHub.ts](file:///workspace/src/server/services/platforms/doneHub.ts) |
| Veloera | [veloera.ts](file:///workspace/src/server/services/platforms/veloera.ts) |
| AnyRouter | [anyrouter.ts](file:///workspace/src/server/services/platforms/anyrouter.ts) |
| Sub2API | [sub2api.ts](file:///workspace/src/server/services/platforms/sub2api.ts) |
| OpenAI | [openai.ts](file:///workspace/src/server/services/platforms/openai.ts) |
| Claude | [claude.ts](file:///workspace/src/server/services/platforms/claude.ts) |
| Gemini | [gemini.ts](file:///workspace/src/server/services/platforms/gemini.ts) |
| Codex | [codex.ts](file:///workspace/src/server/services/platforms/codex.ts) |

### 7. 定时任务服务

#### 签到调度器 ([checkinScheduler.ts](file:///workspace/src/server/services/checkinScheduler.ts))
- 默认 Cron: `0 8 * * *` (每天 8 点)
- 支持定时模式或间隔模式

#### 余额刷新
- 默认 Cron: `0 * * * *` (每小时)
- 批量更新所有活跃账号余额

#### 模型可用性探测
- 可配置间隔（默认 30 分钟）
- Lease 机制防止重复探测

---

## 依赖关系

### 核心依赖树

```
src/server/index.ts (入口)
├── config.ts (配置)
├── db/index.ts (数据库)
├── routes/ (路由)
│   ├── api/ (管理 API)
│   └── proxy/ (代理路由)
├── services/ (业务服务)
│   ├── modelAvailabilityProbeService.ts
│   │   ├── runtimeModelProbe.ts
│   │   └── routeRefreshWorkflow.ts
│   ├── tokenRouter.ts
│   ├── modelService.ts
│   └── platforms/ (平台适配器)
├── proxy-core/ (代理核心)
└── transformers/ (协议转换)
```

### 批量测活功能依赖

```
modelAvailabilityProbeService.ts
├── config.ts (探测配置)
├── db/index.ts (数据库访问)
├── runtimeModelProbe.ts (单个探测)
│   ├── siteProxy.ts (代理配置)
│   ├── runtimeDispatch.ts (请求分发)
│   └── upstreamEndpointRuntime.ts (端点解析)
├── routeRefreshWorkflow.ts (路由重建)
│   └── modelService.ts
└── backgroundTaskService.ts (后台任务)
```

---

## 项目运行方式

### 开发环境

```bash
# 安装依赖
npm install

# 数据库迁移
npm run db:migrate

# 启动开发环境（前后端热更新）
npm run dev
```

### 生产环境 - Docker

```bash
# Docker Compose
cat > docker-compose.yml << 'EOF'
services:
  metapi:
    image: 1467078763/metapi:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/data
    environment:
      AUTH_TOKEN: your-admin-token
      PROXY_TOKEN: your-proxy-sk-token
      CHECKIN_CRON: "0 8 * * *"
      BALANCE_REFRESH_CRON: "0 * * * *"
      MODEL_AVAILABILITY_PROBE_ENABLED: "true"
      MODEL_AVAILABILITY_PROBE_INTERVAL_MS: "1800000"
      TZ: Asia/Shanghai
    restart: unless-stopped
EOF

# 启动
docker compose up -d
```

### 环境变量配置

| 变量 | 说明 |
|------|------|
| `AUTH_TOKEN` | 管理后台令牌 |
| `PROXY_TOKEN` | 代理令牌 |
| `PORT` | 服务端口（默认 4000） |
| `DATA_DIR` | 数据目录 |
| `DB_TYPE` | 数据库类型 (sqlite/mysql/postgres) |
| `DB_URL` | 数据库连接字符串 |
| `CHECKIN_CRON` | 签到 Cron 表达式 |
| `BALANCE_REFRESH_CRON` | 余额刷新 Cron |
| `MODEL_AVAILABILITY_PROBE_ENABLED` | 批量测活开关 |
| `MODEL_AVAILABILITY_PROBE_INTERVAL_MS` | 测活间隔（毫秒） |
| `MODEL_AVAILABILITY_PROBE_TIMEOUT_MS` | 单次探测超时（毫秒） |
| `MODEL_AVAILABILITY_PROBE_CONCURRENCY` | 探测并发数 (1-16) |

### 构建命令

```bash
npm run build          # 构建前端 + 后端
npm run build:web      # 仅构建前端
npm run build:server   # 仅构建后端
npm run dist:desktop   # 构建桌面安装包
npm test               # 运行全部测试
npm run db:generate    # 生成 Drizzle 迁移文件
npm run db:migrate     # 执行数据库迁移
```

---

## 批量测活功能核心逻辑总结

### 核心流程

```
┌─────────────────────────────────────────────────────────┐
│  1. 定时调度 (每 30 分钟)                               │
│     startModelAvailabilityProbeScheduler()               │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│  2. 队列后台任务                                         │
│     queueModelAvailabilityProbeTask()                    │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│  3. 执行探测                                             │
│     executeModelAvailabilityProbe()                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 3.1 获取活跃账号列表                                │  │
│  │ 3.2 遍历账号，尝试获取 Lease                         │  │
│  │ 3.3 加载该账号的待测模型                             │  │
│  │     - modelAvailability 表                          │  │
│  │     - tokenModelAvailability 表                     │  │
│  │ 3.4 跳过 isManual=true 的模型                       │  │
│  └──────────────────────┬────────────────────────────┘  │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│  4. 并发探测 (mapWithConcurrency)                         │
│  ┌───────────────────────────────────────────────────┐   │
│  │ 对每个目标执行 probeSingleTarget()                │   │
│  │   └─ probeRuntimeModel()                          │   │
│  │      ├─ 检查是否为对话模型                          │   │
│  │      ├─ 构建探测请求体                              │   │
│  │      ├─ 发送探测请求                                │   │
│  │      └─ 判定探测结果                                │   │
│  └──────────────────────┬────────────────────────────┘   │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│  5. 更新探测结果                                          │
│     updateProbeRow()                                      │
│  ┌───────────────────────────────────────────────────┐   │
│  │ - 更新 available 状态                               │   │
│  │ - 更新 latencyMs                                    │   │
│  │ - 更新 checkedAt                                    │   │
│  │ - 记录 availabilityChanged 标志                      │   │
│  └──────────────────────┬────────────────────────────┘   │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────▼─────────────────────────────────┐
│  6. 路由重建 (如果可用性有变化)                           │
│     rebuildRoutesOnly()                                    │
└─────────────────────────────────────────────────────────────┘
```

### 关键防护机制

| 机制 | 实现位置 | 作用 |
|------|---------|------|
| **Lease 机制** | `probeAccountLeases` Set | 防止同一账号被并发探测 |
| **超时控制** | `config.modelAvailabilityProbeTimeoutMs` (15秒) + AbortController | 防止探测卡死 |
| **并发控制** | `mapWithConcurrency()` + `config.modelAvailabilityProbeConcurrency` (1-16) | 控制并发压力 |
| **模型过滤** | `NON_CONVERSATION_MODEL_PATTERNS` | 跳过非对话模型（embedding/rerank/whisper等） |
| **手动标记跳过** | `isManual=true` | 跳过手动标记的模型 |
| **确认弹窗** | 设置页面首次开启 | 风险提示，防止误操作 |

### 探测状态判定

| 状态 | 判定条件 |
|------|---------|
| `skipped` | 非对话模型匹配 `NON_CONVERSATION_MODEL_PATTERNS` |
| `inconclusive` | 缺少凭证 / 无可用端点 / 其他错误 |
| `unsupported` | HTTP 400/403/404/422 + 错误信息匹配 `DEFINITE_UNSUPPORTED_PATTERNS` |
| `supported` | 请求成功返回 |

### 配置参数

```typescript
// config.ts 中的相关配置
modelAvailabilityProbeEnabled: boolean;          // 是否启用
modelAvailabilityProbeIntervalMs: number;         // 探测间隔 (默认 30分钟)
modelAvailabilityProbeTimeoutMs: number;          // 单次超时 (默认 15秒)
modelAvailabilityProbeConcurrency: number;        // 并发数 (1-16, 默认 1)
```

---

## 关键 API 端点

### 管理 API (`/api/*`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/sites` | GET/POST/PUT/DELETE | 站点管理 |
| `/api/accounts` | GET/POST/PUT/DELETE | 账号管理 |
| `/api/tokens` | GET/POST/PUT/DELETE | Token 路由管理 |
| `/api/settings` | GET/PUT | 系统设置 |
| `/api/checkin` | POST | 手动触发签到 |
| `/api/stats` | GET | 统计数据 |
| `/api/monitor` | GET | 监控数据 |

### 代理 API (`/v1/*`)

| 端点 | 说明 |
|------|------|
| `/v1/chat/completions` | 聊天补全 |
| `/v1/responses` | Responses API |
| `/v1/embeddings` | 嵌入 |
| `/v1/models` | 模型列表 |
| `/v1/files` | 文件管理 |
| `/v1/images` | 图像生成 |

---

## 测试

```bash
# 运行全部测试
npm test

# 监听模式
npm run test:watch

# Schema 相关测试
npm run test:schema:unit
npm run test:schema:parity
npm run test:schema:upgrade

# 数据库冒烟测试
npm run smoke:db
npm run smoke:db:sqlite
npm run smoke:db:mysql
npm run smoke:db:postgres
```

---

## 开发指南

### 新增平台适配器

1. 在 `src/server/services/platforms/` 下创建新文件
2. 继承 `BasePlatform` 类
3. 实现必要的方法
4. 在 `index.ts` 中注册

### 新增 API 路由

1. 在 `src/server/routes/api/` 下创建路由文件
2. 在 `src/server/index.ts` 中注册

### 数据库迁移

```bash
# 修改 schema.ts 后生成迁移
npm run db:generate

# 执行迁移
npm run db:migrate
```

---

## 安全注意事项

1. **修改默认 Token**: 务必修改 `AUTH_TOKEN` 和 `PROXY_TOKEN`
2. **数据加密**: 所有敏感凭证均加密存储
3. **批量测活风险**: 开启前务必确认中转站允许此类探测
4. **IP 白名单**: 可配置 `ADMIN_IP_ALLOWLIST` 限制管理后台访问
5. **自托管**: 所有数据存储在本地，不向第三方发送

---

## 相关链接

- [GitHub 仓库](https://github.com/cita-777/metapi)
- [在线文档](https://metapi.cita777.me)
- [Docker Hub](https://hub.docker.com/r/1467078763/metapi)

