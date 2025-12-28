# 安装说明

## 项目概述

本项目是一个基于 **Remix + Cloudflare Workers** 构建的全栈论坛应用（AI传感器编程学习论坛）。

### 技术栈

| 技术 | 用途 |
| :--- | :--- |
| [Remix](https://remix.run/) | 全栈 React 框架 |
| [Cloudflare Workers](https://workers.cloudflare.com/) | 边缘计算运行时 |
| [Cloudflare D1](https://developers.cloudflare.com/d1/) | SQLite 分布式数据库 |
| [Cloudflare R2](https://developers.cloudflare.com/r2/) | 对象存储（附件/图片） |
| [Vite](https://vitejs.dev/) | 构建工具 |
| [TailwindCSS](https://tailwindcss.com/) | CSS 框架 |
| [Playwright](https://playwright.dev/) | 端到端测试 |
| [TypeScript](https://www.typescriptlang.org/) | 类型安全 |

---

## 环境要求

- **Node.js** >= 20.0.0
- **npm**（随 Node.js 一同安装）
- **Cloudflare 账号**（用于部署）

---

## 安装步骤

### 1. 克隆项目

```bash
git clone <your-repo-url>
cd remix-starter-template
```

### 2. 安装依赖

```bash
npm install
```

### 3. 环境配置

#### 3.1 本地开发配置

项目使用 `wrangler.json` 管理 Cloudflare 绑定配置。开发环境会自动使用本地模拟的 D1 和 R2。

> [!TIP]
> 本地开发无需额外配置，Wrangler 会自动创建本地 D1 数据库和 R2 存储。

#### 3.2 生产环境配置

编辑 `wrangler.json`，更新以下关键配置：

```json
{
  "vars": {
    "SESSION_SECRET": "your-secure-session-secret",
    "SUPERADMIN_EMAIL": "your-superadmin@example.com",
    "TOPADMIN_EMAIL": "your-topadmin@example.com",
    "PUBLIC_BASE_URL": "https://your-domain.com",
    "EMAIL_PROVIDER": "auto",
    "EMAIL_FROM": "noreply@your-domain.com"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "your_database_name",
      "database_id": "your-database-id"
    }
  ],
  "r2_buckets": [
    {
      "binding": "ATTACHMENTS",
      "bucket_name": "your-bucket-name"
    }
  ]
}
```

> [!IMPORTANT]
> 生产环境请务必更换 `SESSION_SECRET` 为一个随机且安全的字符串！

### 4. 数据库迁移

项目包含 25 个数据库迁移文件，位于 `migrations/` 目录。

#### 本地开发

Wrangler 开发模式会自动应用迁移。

#### 生产环境

使用 Wrangler 手动执行迁移：

```bash
# 查看待执行迁移
wrangler d1 migrations list forum_db --remote

# 执行迁移
wrangler d1 migrations apply forum_db --remote
```

### 5. 生成类型

每次修改 `wrangler.json` 后需重新生成类型：

```bash
npm run typegen
```

---

## 运行项目

### 开发模式

```bash
npm run dev
```

访问 [http://localhost:5173](http://localhost:5173)

### 预览模式（使用 Wrangler）

```bash
npm run preview
```

或分步执行：

```bash
npm run build
npm start
```

---

## 部署

### 首次部署

1. 登录 Cloudflare：
   ```bash
   wrangler login
   ```

2. 创建 D1 数据库：
   ```bash
   wrangler d1 create forum_db
   ```

3. 创建 R2 存储桶：
   ```bash
   wrangler r2 bucket create your-bucket-name
   ```

4. 更新 `wrangler.json` 中的数据库 ID 和存储桶名称。

5. 部署应用：
   ```bash
   npm run deploy
   ```

### 后续部署

```bash
npm run deploy
```

---

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npm run deploy` | 部署到 Cloudflare |
| `npm run typegen` | 生成 Cloudflare 类型 |
| `npm run lint` | 运行 ESLint 检查 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run test:e2e` | 运行端到端测试 |
| `npm run test:unit` | 运行单元测试 |

---

## 目录结构

```
remix-starter-template/
├── app/                    # 应用源码
│   ├── components/         # React 组件
│   ├── lib/               # 服务端工具库
│   │   ├── auth.server.ts # 认证与权限
│   │   ├── session.server.ts # 会话管理
│   │   └── ...
│   ├── routes/            # 页面路由（约定式路由）
│   ├── root.tsx           # 根布局
│   └── tailwind.css       # 样式入口
├── build/                 # 构建产物
├── manuals/              # 用户手册
├── migrations/           # D1 数据库迁移脚本
├── public/               # 静态资源
├── tests/                # 测试文件
│   ├── e2e/             # 端到端测试
│   └── unit/            # 单元测试
├── package.json          # 项目配置
├── server.ts            # Cloudflare Worker 入口
├── vite.config.ts       # Vite 配置
├── wrangler.json        # Cloudflare 配置
└── tsconfig.json        # TypeScript 配置
```

---

## 常见问题

### Q: 如何查看本地 D1 数据库？

```bash
wrangler d1 execute forum_db --local --command "SELECT * FROM users LIMIT 10;"
```

### Q: 部署时提示数据库不存在？

确保已在 Cloudflare 创建 D1 数据库，并将 `database_id` 更新到 `wrangler.json`。

### Q: 如何重置本地开发数据？

删除 `.wrangler` 目录：

```bash
rm -rf .wrangler
```

---

## 版本记录

| 版本 | 日期 | 说明 |
| :--- | :--- | :--- |
| v1.0 | 2025-12-28 | 首次发布 |

**最后更新**：2025-12-28
