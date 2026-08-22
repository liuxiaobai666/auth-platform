# 授权中心后端镜像(NestJS + Prisma)
# 构建上下文 = 仓库根目录(见 docker-compose.yml)
FROM node:20-bookworm-slim

# openssl: Prisma 运行时需要;python3/make/g++: 编译 argon2 等原生模块
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

WORKDIR /app

# ---- 依赖层(仅拷 manifest,充分利用缓存)----
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/server/package.json        packages/server/
COPY packages/admin/package.json         packages/admin/
COPY packages/sdk-node/package.json      packages/sdk-node/
COPY packages/example-client/package.json packages/example-client/
RUN pnpm install --filter @jc-kami/server... --frozen-lockfile

# ---- 源码 + 构建 ----
COPY packages/server packages/server
# 后台「完整文档」页直接读这份 markdown。不带进镜像的话页面是空的，
# 而且只在生产环境空——本地跑有 docs 目录，测不出来。
COPY docs docs
RUN pnpm --filter @jc-kami/server prisma:generate \
 && pnpm --filter @jc-kami/server build

COPY packages/server/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

WORKDIR /app/packages/server
ENV NODE_ENV=production
EXPOSE 8848
# 启动时:先跑迁移建表 → 幂等初始化管理员 → 启动服务
ENTRYPOINT ["/app/docker-entrypoint.sh"]
