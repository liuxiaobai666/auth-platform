#!/usr/bin/env bash
# 清空业务数据与日志，保留管理员账号和内置角色。
#
# 用途：
#   1. 联调测试会在库里留下应用、卡密和大量日志（scripts/mint-test-licenses.sh
#      会创建 sdk_demo 应用），上线前用这个脚本清干净；
#   2. 想把演示环境重置成空白状态时也用它。
#
# 用法：bash scripts/cleanup-demo-data.sh [数据库名] [--yes]
set -e

DB="${1:-jc_kami}"
AUTO_YES=""
for a in "$@"; do [ "$a" = "--yes" ] && AUTO_YES=1; done

MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_ARGS="-u $MYSQL_USER"
[ -n "$MYSQL_PASSWORD" ] && MYSQL_ARGS="$MYSQL_ARGS -p$MYSQL_PASSWORD"

echo "目标数据库: $DB"
echo
echo "当前数据量："
mysql $MYSQL_ARGS "$DB" -e "
SELECT 'applications' AS 表, COUNT(*) AS 行数 FROM applications
UNION ALL SELECT 'license_keys', COUNT(*) FROM license_keys
UNION ALL SELECT 'license_devices', COUNT(*) FROM license_devices
UNION ALL SELECT 'license_activations', COUNT(*) FROM license_activations
UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs
UNION ALL SELECT 'api_request_logs', COUNT(*) FROM api_request_logs;" | sed 's/^/  /'
echo
echo "将清空上述全部业务数据与日志。管理员账号与内置角色会保留。"
echo "此操作不可撤销。"

if [ -z "$AUTO_YES" ]; then
  printf "确认继续？输入 yes 回车: "
  read -r answer
  [ "$answer" = "yes" ] || { echo "已取消"; exit 1; }
fi

mysql $MYSQL_ARGS "$DB" <<'SQL'
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE webhook_deliveries;
TRUNCATE TABLE webhook_endpoints;
TRUNCATE TABLE license_batches;
TRUNCATE TABLE license_reservations;
TRUNCATE TABLE license_token_revocations;
TRUNCATE TABLE license_key_exports;
TRUNCATE TABLE license_activations;
TRUNCATE TABLE license_devices;
TRUNCATE TABLE license_keys;
TRUNCATE TABLE plans;
TRUNCATE TABLE app_releases;
TRUNCATE TABLE application_plugins;
TRUNCATE TABLE applications;
TRUNCATE TABLE idempotency_records;
TRUNCATE TABLE audit_logs;
TRUNCATE TABLE login_logs;
TRUNCATE TABLE api_request_logs;
SET FOREIGN_KEY_CHECKS = 1;
SQL

# 版本记录清掉后，磁盘上的安装包就再也没有引用了，一并删除
STORAGE="${RELEASE_STORAGE_DIR:-./storage/releases}"
if [ -d "$STORAGE" ]; then
  COUNT=$(find "$STORAGE" -type f | wc -l | tr -d ' ')
  find "$STORAGE" -type f -delete
  echo "已删除 $COUNT 个安装包文件"
fi

# nonce 与限流计数都是易失数据，一并清掉避免影响后续测试
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli -n "${REDIS_DB:-0}" flushdb >/dev/null 2>&1 && echo "已清空 Redis 缓存"
fi

echo
echo "清理完成。保留的账号与角色："
mysql $MYSQL_ARGS "$DB" -e "SELECT username, nickname FROM admin_users;" | sed 's/^/  /'
