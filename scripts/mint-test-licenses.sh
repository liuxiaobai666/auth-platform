#!/usr/bin/env bash
# 为 SDK 联调测试准备环境：创建应用与套餐（若不存在），并发一批全新卡密。
# 用法：bash scripts/mint-test-licenses.sh [服务端地址] [管理员] [密码]
set -e
API="${1:-http://127.0.0.1:3100}/api/v1"
USER="${2:-admin}"
PASS="${3:-Admin@123456}"
ENV_FILE="${JC_SDK_ENV:-/tmp/sdk.env}"

TOKEN=$(curl -s -X POST "$API/admin/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" | jq -r .access_token)
[ "$TOKEN" = "null" ] && { echo "登录失败，请检查地址与账号"; exit 1; }
AUTH="Authorization: Bearer $TOKEN"

APP_ROW=$(curl -s "$API/admin/applications?keyword=sdk_demo" -H "$AUTH" | jq -r '.items[0].id // empty')
if [ -z "$APP_ROW" ]; then
  echo "创建联调应用 sdk_demo ..."
  APP=$(curl -s -X POST "$API/admin/applications" -H "$AUTH" -H 'Content-Type: application/json' \
    -d '{"app_id":"sdk_demo","name":"SDK 联调应用","type":"other"}')
  APP_ROW=$(echo "$APP" | jq -r .id)
  PLUGIN=$(echo "$APP" | jq -r .default_plugin.plugin_id)
  PTOKEN=$(echo "$APP" | jq -r .default_plugin.credentials.plugin_token)
  PSECRET=$(echo "$APP" | jq -r .default_plugin.credentials.plugin_secret)
else
  PLG=$(curl -s "$API/admin/plugins?application_id=$APP_ROW" -H "$AUTH" | jq -r '.items[0].id')
  CRED=$(curl -s "$API/admin/plugins/$PLG/credentials" -H "$AUTH")
  PLUGIN=$(echo "$CRED" | jq -r .plugin_id)
  PTOKEN=$(echo "$CRED" | jq -r .plugin_token)
  PSECRET=$(echo "$CRED" | jq -r .plugin_secret)
fi

PLAN=$(curl -s "$API/admin/plans?application_id=$APP_ROW" -H "$AUTH" | jq -r '.items[0].id // empty')
if [ -z "$PLAN" ]; then
  echo "创建联调套餐 ..."
  PLAN=$(curl -s -X POST "$API/admin/plans" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"application_id\":\"$APP_ROW\",\"code\":\"month\",\"name\":\"月卡\",\"duration_days\":30,\"device_limit\":2,\"allow_rebind\":true,\"rebind_limit\":2,\"offline_grace_hours\":48}" | jq -r .id)
fi

# 每次都发新卡：联调会消耗设备名额和换绑配额，复用旧卡会让测试第二次跑就失败
GEN=$(curl -s -X POST "$API/admin/licenses/generate" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"plan_id\":\"$PLAN\",\"count\":9,\"prefix\":\"TMP\",\"note\":\"SDK 联调临时卡\"}")

{
  echo "SDK_APP_ROW=$APP_ROW"
  echo "SDK_PLAN=$PLAN"
  echo "SDK_PLUGIN=$PLUGIN"
  echo "SDK_TOKEN=$PTOKEN"
  echo "SDK_SECRET=$PSECRET"
  for i in 0 1 2 3 4 5 6 7 8; do
    echo "SDK_FRESH$((i+1))=$(echo "$GEN" | jq -r ".keys[$i]")"
  done
} > "$ENV_FILE"

echo "已写入 ${ENV_FILE} — 应用 sdk_demo，6 张新卡"
