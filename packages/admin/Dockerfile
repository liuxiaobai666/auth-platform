# 后台前端镜像:node 构建静态文件 → nginx 托管 + 反代 /api 到后端
# 构建上下文 = 仓库根目录
FROM node:20-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/server/package.json        packages/server/
COPY packages/admin/package.json         packages/admin/
COPY packages/sdk-node/package.json      packages/sdk-node/
COPY packages/example-client/package.json packages/example-client/
RUN pnpm install --filter @jc-kami/admin... --frozen-lockfile

COPY packages/admin packages/admin
RUN pnpm --filter @jc-kami/admin build

# ---- 运行期:nginx ----
FROM nginx:1.27-alpine
COPY packages/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/admin/dist /usr/share/nginx/html
EXPOSE 80
