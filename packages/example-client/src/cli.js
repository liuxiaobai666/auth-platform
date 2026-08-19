#!/usr/bin/env node
/**
 * 示例客户端：演示一个真实项目如何接入卡密平台。
 *
 * 用法：
 *   node src/cli.js policy            拉取远程管控策略
 *   node src/cli.js activate <卡密>   激活本机
 *   node src/cli.js run               模拟应用启动（启动校验 + 策略处理）
 *   node src/cli.js status            查询授权状态
 *   node src/cli.js deactivate        解绑本机（消耗换绑次数）
 *   node src/cli.js reset             仅清除本地凭据
 */
const fs = require('fs');
const path = require('path');
const { LicenseClient, LicenseError, LicenseErrorCode } = require('@jc-kami/sdk');

// ---- 读取配置：优先环境变量，其次同目录 .env ----
function loadEnv() {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const client = new LicenseClient({
  appId: process.env.JC_APP_ID,
  serverUrl: process.env.JC_SERVER_URL,
  pluginId: process.env.JC_PLUGIN_ID,
  pluginToken: process.env.JC_PLUGIN_TOKEN,
  pluginSecret: process.env.JC_PLUGIN_SECRET,
  clientVersion: process.env.JC_CLIENT_VERSION || '1.0.0',
  channel: process.env.JC_CHANNEL || 'stable',
  storageDir: process.env.JC_STORAGE_DIR,
  deviceName: process.env.JC_DEVICE_NAME,
  onPolicy: handlePolicy,
});

/** 策略处理：这段逻辑就是「远程升级和关停」在客户端的落地。 */
function handlePolicy(policy) {
  if (policy.notice) {
    const tag = { info: 'ℹ 公告', warning: '⚠ 公告', critical: '‼ 重要公告' }[policy.notice.level];
    console.log(C.warn(`\n${tag}：${policy.notice.title}`));
    if (policy.notice.content) console.log(C.dim(`  ${policy.notice.content}`));
  }
  const up = policy.upgrade;
  if (up.required) {
    console.log(C.err(`\n必须升级到 ${up.latest_version} 才能继续使用`));
    if (up.message) console.log(C.dim(`  ${up.message}`));
    if (up.download_url) console.log(`  下载地址: ${up.download_url}`);
    if (up.sha256) console.log(C.dim(`  校验和: ${up.sha256}`));
  } else if (up.available) {
    console.log(C.warn(`\n有新版本 ${up.latest_version} 可用（非强制）`));
    if (up.release_notes) console.log(C.dim(`  更新内容: ${up.release_notes}`));
    if (up.download_url) console.log(C.dim(`  下载地址: ${up.download_url}`));
  }
}

function fail(e) {
  if (e instanceof LicenseError) {
    console.log(C.err(`\n[${e.code}] ${e.message}`));
    if (e.requestId) console.log(C.dim(`  request_id: ${e.requestId}（报障时请提供）`));
    // 针对不同错误码给出可操作的指引，而不是把错误原样丢给用户
    const hint = {
      [LicenseErrorCode.DEVICE_LIMIT_EXCEEDED]: '请先在其他设备上执行 deactivate，或联系客服解绑',
      [LicenseErrorCode.LICENSE_EXPIRED]: '授权已到期，请续费后重试',
      [LicenseErrorCode.LICENSE_BANNED]: '该卡密已被封禁，请联系客服',
      [LicenseErrorCode.REBIND_LIMIT_EXCEEDED]: '换绑次数已用完，请联系客服',
      [LicenseErrorCode.CLIENT_VERSION_TOO_LOW]: '请下载最新版本后重试',
      [LicenseErrorCode.APP_KILLED]: '服务已停止提供，请联系服务方',
      [LicenseErrorCode.NOT_ACTIVATED_LOCALLY]: '请先运行: node src/cli.js activate <卡密>',
      [LicenseErrorCode.NETWORK_UNAVAILABLE]: '请检查网络后重试',
    }[e.code];
    if (hint) console.log(C.dim(`  → ${hint}`));
    process.exit(2);
  }
  console.log(C.err(`\n未预期的错误: ${e.stack || e.message}`));
  process.exit(1);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  console.log(C.dim(`设备指纹: ${client.deviceId.slice(0, 16)}... | 版本: ${process.env.JC_CLIENT_VERSION}`));

  switch (cmd) {
    case 'policy': {
      const p = await client.fetchPolicy();
      console.log(`\n应用状态: ${p.kill_switch ? C.err('已远程关停') : C.ok(p.app_status)}` +
                  `${p.maintenance ? C.warn(' (维护中)') : ''}`);
      console.log(`最低版本: ${p.min_version ?? '不限'}  最新版本: ${p.upgrade.latest_version ?? '未发布'}`);
      break;
    }

    case 'activate': {
      if (!arg) { console.log(C.err('请提供卡密: activate <卡密>')); process.exit(1); }
      const r = await client.activate(arg);
      console.log(C.ok(`\n✓ 激活成功`));
      console.log(`  授权 ID  : ${r.license_id}`);
      console.log(`  到期时间 : ${r.is_permanent ? '永久' : r.expires_at}`);
      console.log(`  设备占用 : ${r.device_count}/${r.device_limit}`);
      console.log(`  剩余换绑 : ${r.rebind_remaining === null ? '不限' : r.rebind_remaining}`);
      break;
    }

    // 模拟真实应用启动：先校验授权，再按策略决定能不能跑
    case 'run': {
      const r = await client.verify();
      if (r.policy.upgrade.required) {
        console.log(C.err('\n启动中止：必须升级后才能使用'));
        process.exit(3);
      }
      console.log(C.ok(`\n✓ 授权有效${r.offline ? C.warn('（离线宽限期内，未联网）') : ''}`));
      console.log(`  到期时间: ${r.is_permanent ? '永久' : r.expires_at}`);
      console.log(C.bold('\n>>> 应用主逻辑开始执行 <<<'));
      console.log('    ... 这里是你自己的业务代码 ...');
      break;
    }

    case 'status': {
      const s = await client.status(arg);
      console.log(`\n状态: ${s.status}  设备: ${s.device_count}/${s.device_limit}  ` +
                  `本机已绑定: ${s.device_bound ? '是' : '否'}`);
      console.log(`换绑: 已用 ${s.rebind_count}${s.rebind_limit === null ? '' : '/' + s.rebind_limit}`);
      break;
    }

    case 'deactivate': {
      await client.deactivate('用户在客户端主动解绑');
      console.log(C.ok('\n✓ 已解绑本机，可在新设备上激活'));
      break;
    }

    case 'reset':
      client.clearLocal();
      console.log(C.ok('\n✓ 本地凭据已清除（服务端绑定关系不变）'));
      break;

    default:
      console.log(`\n用法: node src/cli.js <policy|activate <卡密>|run|status|deactivate|reset>`);
      process.exit(1);
  }
}

main().catch(fail);
