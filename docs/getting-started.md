# 🚀 快速上手

本文档帮助你在 10 分钟内完成 Metapi 的首次部署。

[返回文档中心](./README.md)

---

## 前置条件

按你的使用场景准备对应环境：

| 场景 | 推荐方式 | 需要准备 |
|------|----------|----------|
| 云服务器 / NAS / 家用主机长期运行 | Docker / Docker Compose | Docker 与 Docker Compose |
| 个人电脑本地使用 | 桌面版安装包 | 从 [Releases](https://github.com/cita-777/metapi/releases) 下载对应系统的桌面安装包 |
| 二次开发 / 调试 | 本地开发 | Node.js 20+ 与 npm |

> [!NOTE]
> - 当前不再把 `Release` 压缩包 + Node.js 运行时作为独立部署路径。
> - 想直接运行成品，请用 Docker 或桌面版；想改代码，请走本地开发流程。

## 方式一：Docker Compose 部署（推荐）

### 1. 创建项目目录

```bash
mkdir metapi && cd metapi
```

### 2. 创建 `docker-compose.yml`

```yaml
services:
  metapi:
    image: 1467078763/metapi:latest
    ports:
      - "4000:4000"
    volumes:
      - ./data:/app/data
    environment:
      AUTH_TOKEN: ${AUTH_TOKEN:?AUTH_TOKEN is required}
      PROXY_TOKEN: ${PROXY_TOKEN:?PROXY_TOKEN is required}
      CHECKIN_CRON: "0 8 * * *"
      BALANCE_REFRESH_CRON: "0 * * * *"
      PORT: ${PORT:-4000}
      DATA_DIR: /app/data
      TZ: ${TZ:-Asia/Shanghai}
    restart: unless-stopped
```

### 3. 设置令牌并启动

```bash
# AUTH_TOKEN = 管理后台初始管理员令牌（登录后台时输入这个值）
export AUTH_TOKEN=your-admin-token
# PROXY_TOKEN = 下游客户端调用 /v1/* 使用的令牌
export PROXY_TOKEN=your-proxy-sk-token
docker compose up -d
```

### 4. 访问管理后台

打开 `http://localhost:4000`，使用 `AUTH_TOKEN` 的值登录。

> [!TIP]
> 初始管理员令牌就是启动时配置的 `AUTH_TOKEN`。  
> 如果未显式设置（非 Compose 场景），默认值为 `change-me-admin-token`（仅建议本地调试）。  
> 若你在后台「设置」里修改过管理员令牌，后续登录请使用新令牌。

## 方式二：桌面版启动（Windows / macOS / Linux）

如果你是在个人电脑上本地使用，请直接下载桌面版安装包：

1. 打开 [Releases](https://github.com/cita-777/metapi/releases) 下载与你系统匹配的桌面安装包
2. 安装并启动 Metapi Desktop
3. 桌面壳会自动启动本地服务并保存数据，无需手动准备 Node.js 环境

| 项目 | 说明 |
|------|------|
| 管理界面 | 应用启动后会直接打开桌面窗口，不需要假设固定的 `http://localhost:4000` |
| 本地后端地址 | 桌面版把内置服务绑定到 `127.0.0.1`，默认会在 `4310..4399` 中挑选空闲端口；只有显式设置 `METAPI_DESKTOP_SERVER_PORT` 时才会固定 |
| 数据目录 | 保存在 `app.getPath('userData')/data`，不是仓库里的 `./data` |
| 日志目录 | 保存在 `app.getPath('userData')/logs`；托盘菜单提供 `Open Logs Folder` |

> [!TIP]
> - Windows 下常见路径是 `%APPDATA%\Metapi\data` 和 `%APPDATA%\Metapi\logs`。
> - 如果你要把本机其他客户端接到桌面版内置后端，先到日志里查当前端口，不要写死 `4000`。

> [!NOTE]
> 服务器部署统一推荐 Docker / Docker Compose，不再提供裸 Node.js 的 Release 压缩包。

## 方式三：本地开发启动

```bash
git clone https://github.com/cita-777/metapi.git
cd metapi
npm install
npm run db:migrate
npm run dev
```

- 前端地址：`http://localhost:5173`（Vite dev server）
- 后端地址：`http://localhost:4000`
- 这是源码开发流程，不是免 Docker 的成品部署包

## 首次使用流程

完成部署后，按以下顺序配置：

> [!TIP] 从 ALL-API-Hub 迁移（可选）
> 如果你使用过 ALL-API-Hub，Metapi 兼容其导出的备份设置，可直接导入，无需手动逐项配置。
>
> ![ALL-API-Hub备份导入](./screenshots/allapi-hub-backup.png)

### 步骤 1：添加站点

进入 **站点管理**，添加你使用的上游中转站：

- 填写站点名称（自己想怎么取就怎么取）和 URL
- 选择平台类型（`new-api` / `one-api` / `one-hub` / `done-hub` / `veloera` / `anyrouter` / `sub2api` / `openai` / `claude` / `gemini` / `cliproxyapi`），通常可自动检测
- 填写站点的管理员 API Key（可选，部分功能需要）

如果你不确定该选哪个平台，先看 [上游接入](./upstream-integration.md)。

![站点管理](./screenshots/site-management.png)

### 步骤 2：添加账号

首先前往你想添加的公益站，进入下图界面：

![账号管理](./screenshots/account-management.png)

进入 **账号管理**，为每个站点添加已注册的账号：



![账号余额](./screenshots/account-balance.png)

- 填入用户名和访问凭证

  ![账号凭证](./screenshots/account-credentials.png)

- 系统会自动登录并获取余额信息

![账号余额](./screenshots/account-balance.png)

- 启用自动签到（如站点支持）

### 步骤 3：同步 Token

进入 **Token 管理**：

- 点击「同步」从上游账号拉取 API Key

- 或手动添加已有的 API Key，如下图所示。

  ![Token管理](./screenshots/token-management.png)

### 步骤 4：检查路由

进入 **路由管理**：

- 系统会自动发现模型并生成路由规则
- 可以手动调整通道的优先级和权重

### 步骤 5：验证代理

按运行方式选择验证入口：

| 运行方式 | 管理界面 | 代理接口基地址 |
|----------|----------|----------------|
| Docker / Docker Compose | `http://localhost:4000` | `http://localhost:4000` |
| 本地开发 | `http://localhost:5173` | `http://localhost:4000` |
| 桌面版 | 直接使用桌面窗口 | 先从日志里的 `Proxy API:` 行确认当前 `http://127.0.0.1:<port>` |

### Docker / 本地开发：直接用 curl 验证

```bash
# 检查模型列表
curl -sS http://localhost:4000/v1/models \
  -H "Authorization: Bearer your-proxy-sk-token"

# 测试对话
curl -sS http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-sk-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

### 桌面版：先确认当前端口再验证

打开托盘菜单的 `Open Logs Folder`，在最新日志里查找类似下面的启动信息：

```text
Dashboard: http://127.0.0.1:4312
Proxy API: http://127.0.0.1:4312/v1/chat/completions
```

然后把日志里的实际端口替换进 curl：

```bash
curl -sS http://127.0.0.1:4312/v1/models \
  -H "Authorization: Bearer your-proxy-sk-token"
```

返回正常响应，说明代理链路已经可用。

## 下一步

- [上游接入](./upstream-integration.md) — 当前代码支持哪些上游、默认该走哪个连接分段
- [部署指南](./deployment.md) — 反向代理、HTTPS、升级策略
- [配置说明](./configuration.md) — 详细环境变量与路由参数
- [客户端接入](./client-integration.md) — 对接 Open WebUI、Cherry Studio 等
