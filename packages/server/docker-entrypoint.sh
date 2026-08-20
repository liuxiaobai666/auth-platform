#!/bin/sh
# 后端容器启动流程:迁移 → 初始化管理员(幂等)→ 启动
set -e
cd /app/packages/server

echo "▶ [1/3] 应用数据库迁移(prisma migrate deploy)..."
pnpm exec prisma migrate deploy

echo "▶ [2/3] 初始化角色与管理员(幂等 upsert,已存在则跳过)..."
pnpm run prisma:seed

echo "▶ [3/3] 启动授权中心..."
exec node dist/main.js
