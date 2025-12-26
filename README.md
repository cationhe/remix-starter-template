# Welcome to Remix + Cloudflare Workers!

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/remix-starter-template)

<!-- dash-content-start -->

Build a fullstack Remix application, deployed to Cloudflare Workers.

- 📖 [Remix docs](https://remix.run/docs)
- 📖 [Remix Cloudflare docs](https://remix.run/guides/vite#cloudflare)

<!-- dash-content-end -->

## Development

Run the dev server:

```sh
npm run dev
```

To run Wrangler:

```sh
npm run build
npm start
```

## Typegen

Generate types for your Cloudflare bindings in `wrangler.toml`:

```sh
npm run typegen
```

You will need to rerun typegen whenever you make changes to `wrangler.toml`.

## Deployment

If you don't already have an account, then [create a cloudflare account here](https://dash.cloudflare.com/sign-up) and after verifying your email address with Cloudflare, go to your dashboard and set up your free custom Cloudflare Workers subdomain.

Once that's done, you should be able to build your app:

```sh
npm run build
```

And deploy it:

```sh
npm run deploy
```

## Styling

This template comes with [Tailwind CSS](https://tailwindcss.com/) already configured for a simple default starting experience. You can use whatever css framework you prefer. See the [Vite docs on css](https://vitejs.dev/guide/features.html#css) for more information.

## 权限体系（RBAC）

- 角色：`superadmin` / `topadmin` / `admin` / `user`
- 角色判断：`app/lib/auth.server.ts:35-41`（`isAdmin`、`isSuperadmin`）
- 讨论区管理：`/admin/discussion-areas`（`app/routes/admin.discussion-areas.tsx`）
  - 访问：仅 `superadmin` 或 `topadmin`
  - 保存排序：仅 `isSuperadmin`（`superadmin/topadmin`）
- 帖子置顶：`/posts/:id` 的 `setPin`（`app/routes/posts.$id.tsx`）
  - 仅 `isSuperadmin`（`superadmin/topadmin`）可置顶/取消置顶
- 审计记录：写入 `security_audit_logs`（迁移见 `migrations/0005_security_audit_logs.sql`）

## 附件上传限制（论坛）

- 单个附件大小范围：10B–100MB
