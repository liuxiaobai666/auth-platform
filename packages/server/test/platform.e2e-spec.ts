import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AuthService } from '../src/modules/auth/auth.service';
import { BUILTIN_ROLES } from '../src/common/auth/permissions';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { ConsumeService } from '../src/modules/open/services/consume.service';
import { adminAuth, PluginCreds, pluginRequest } from './helpers';

jest.setTimeout(120_000);

describe('卡密平台端到端测试', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let superToken: string;
  let viewerToken: string;
  let appRowId: string;
  let planMonthId: string;
  let planNoRebindId: string;
  let planCountId: string;
  let creds: PluginCreds;
  let otherCreds: PluginCreds;
  let otherAppId: string;

  const APP_ID = 'e2e_app';
  const OTHER_APP_ID = 'e2e_other';
  const genId = (p: string) => `${p}_${Math.random().toString(16).slice(2, 14)}${Date.now().toString(16).slice(-10)}`;

  /** 生成卡密并返回明文，测试里频繁需要一张全新的卡 */
  async function newLicense(planId = planMonthId, overrides: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/licenses/generate')
      .set(adminAuth(superToken))
      .send({ plan_id: planId, count: 1, ...overrides })
      .expect(200);
    return { key: res.body.keys[0] as string, batchId: res.body.batch_id as string };
  }

  async function licenseIdByKey(key: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get('/api/v1/admin/licenses')
      .query({ key })
      .set(adminAuth(superToken))
      .expect(200);
    return res.body.items[0].id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app as NestExpressApplication);
    // 真正监听一个端口：接入文档的在线测试代理会向本机回环自转发，
    // 内存实例（只 init 不 listen）收不到那个请求
    process.env.PORT = '3199';
    await app.listen(3199);

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await prisma.truncateAll();
    await redis.raw.flushdb();

    // ---- 初始化角色与管理员 ----
    for (const role of BUILTIN_ROLES) {
      await prisma.adminRole.create({
        data: {
          id: genId('rol'), code: role.code, name: role.name,
          description: role.description, permissions: role.permissions as any, isBuiltin: true,
        },
      });
    }
    const hash = await AuthService.hashPassword('Admin@123456');
    await prisma.adminUser.create({
      data: { id: genId('usr'), username: 'admin', passwordHash: hash, nickname: '超管', isSuperAdmin: true },
    });
    const viewerRole = await prisma.adminRole.findUnique({ where: { code: 'viewer' } });
    const viewer = await prisma.adminUser.create({
      data: { id: genId('usr'), username: 'viewer', passwordHash: hash, nickname: '只读' },
    });
    await prisma.adminUserRole.create({ data: { adminUserId: viewer.id, roleId: viewerRole!.id } });

    // ---- 登录取令牌 ----
    superToken = (await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'admin', password: 'Admin@123456' })
      .expect(200)).body.access_token;

    viewerToken = (await request(app.getHttpServer())
      .post('/api/v1/admin/auth/login')
      .send({ username: 'viewer', password: 'Admin@123456' })
      .expect(200)).body.access_token;

    // ---- 造应用、套餐、插件 ----
    appRowId = (await request(app.getHttpServer())
      .post('/api/v1/admin/applications').set(adminAuth(superToken))
      .send({ app_id: APP_ID, name: '端到端测试应用', type: 'windows' })
      .expect(201)).body.id;

    otherAppId = (await request(app.getHttpServer())
      .post('/api/v1/admin/applications').set(adminAuth(superToken))
      .send({ app_id: OTHER_APP_ID, name: '另一个应用' })
      .expect(201)).body.id;

    planMonthId = (await request(app.getHttpServer())
      .post('/api/v1/admin/plans').set(adminAuth(superToken))
      .send({
        application_id: appRowId, code: 'month', name: '月卡', duration_days: 30,
        device_limit: 2, allow_rebind: true, rebind_limit: 2, offline_grace_hours: 48,
      }).expect(201)).body.id;

    planNoRebindId = (await request(app.getHttpServer())
      .post('/api/v1/admin/plans').set(adminAuth(superToken))
      .send({
        application_id: appRowId, code: 'strict', name: '严格卡', duration_days: 30,
        device_limit: 1, allow_rebind: false, offline_grace_hours: 0,
      }).expect(201)).body.id;

    planCountId = (await request(app.getHttpServer())
      .post('/api/v1/admin/plans').set(adminAuth(superToken))
      .send({
        application_id: appRowId, code: 'countpack', name: '次数包', duration_days: 30,
        device_limit: 2, quota_per_device: 5,
      }).expect(201)).body.id;

    const plugin = (await request(app.getHttpServer())
      .post('/api/v1/admin/plugins').set(adminAuth(superToken))
      .send({ application_id: appRowId, plugin_id: 'e2e_plugin', name: '测试插件' })
      .expect(201)).body;
    creds = { pluginId: plugin.plugin_id, token: plugin.credentials.plugin_token, secret: plugin.credentials.plugin_secret };

    const other = (await request(app.getHttpServer())
      .post('/api/v1/admin/plugins').set(adminAuth(superToken))
      .send({ application_id: otherAppId, plugin_id: 'e2e_other_plugin', name: '另一个插件' })
      .expect(201)).body;
    otherCreds = { pluginId: other.plugin_id, token: other.credentials.plugin_token, secret: other.credentials.plugin_secret };
  });

  afterAll(async () => {
    await redis.raw.flushdb().catch(() => undefined);
    await app.close();
  });

  // 每个用例前清限流计数，避免用例之间互相触发限流
  beforeEach(async () => {
    const keys = await redis.raw.keys('rl:*');
    if (keys.length) await redis.raw.del(...keys);
  });

  // ==================================================================
  describe('1. 管理员登录与权限', () => {
    it('正确的用户名密码可以登录并拿到权限清单', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ username: 'admin', password: 'Admin@123456' })
        .expect(200);
      expect(res.body.access_token).toBeTruthy();
      expect(res.body.refresh_token).toBeTruthy();
      expect(res.body.admin.is_super_admin).toBe(true);
      expect(res.body.admin.permissions).toContain('license:export');
    });

    it('密码错误返回 BAD_CREDENTIALS', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ username: 'admin', password: 'wrong-password' })
        .expect(401);
      expect(res.body.code).toBe('BAD_CREDENTIALS');
      expect(res.body.request_id).toBeTruthy();
    });

    it('用户名不存在与密码错误返回同样的错误码，不泄露账号是否存在', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ username: 'no-such-user', password: 'whatever' })
        .expect(401);
      expect(res.body.code).toBe('BAD_CREDENTIALS');
    });

    it('连续输错达到上限后账号被锁定', async () => {
      const username = 'locktest';
      await prisma.adminUser.create({
        data: {
          id: genId('usr'), username,
          passwordHash: await AuthService.hashPassword('Admin@123456'), nickname: '锁定测试',
        },
      });
      // 清掉本 IP 的登录限流计数，确保这 5 次失败走的是「账号锁定」而不是「限流」——
      // 否则前序用例累积的失败次数可能让第 5 次前就撞上 RATE_LIMITED
      const rl = app.get<RedisService>(RedisService);
      const rk = await rl.raw.keys('rl:login:*');
      if (rk.length) await rl.raw.del(...rk);

      let lastCode = '';
      for (let i = 0; i < 5; i++) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/auth/login').send({ username, password: 'bad' });
        lastCode = res.body.code;
      }
      expect(lastCode).toBe('ACCOUNT_LOCKED');

      // 锁定期内即使密码正确也不放行
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login').send({ username, password: 'Admin@123456' });
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
    });

    it('登录接口按用户名维度限流', async () => {
      const codes: string[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/auth/login').send({ username: 'ratelimit-probe', password: 'x' });
        codes.push(res.body.code);
      }
      expect(codes).toContain('RATE_LIMITED');
    });

    it('无令牌访问管理接口返回 UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/applications').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('伪造的令牌返回 TOKEN_INVALID', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/applications')
        .set(adminAuth('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.bogussignature'))
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('只读管理员不能执行写操作和导出', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/applications').set(adminAuth(viewerToken))
        .send({ app_id: 'viewer_should_fail', name: '不该成功' })
        .expect(403);
      expect(create.body.code).toBe('PERMISSION_DENIED');

      const exportRes = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/export').set(adminAuth(viewerToken))
        .send({ application_id: appRowId })
        .expect(403);
      expect(exportRes.body.code).toBe('PERMISSION_DENIED');

      // 只读权限内的查询仍然正常
      await request(app.getHttpServer())
        .get('/api/v1/admin/applications').set(adminAuth(viewerToken)).expect(200);
    });

    it('退出登录后原访问令牌立即失效', async () => {
      // 用一次性账号：退出会递增 tokenVersion，拿共享账号做会作废别的用例正在用的令牌
      await prisma.adminUser.create({
        data: {
          id: genId('usr'), username: 'logout-probe',
          passwordHash: await AuthService.hashPassword('Admin@123456'), nickname: '退出测试',
        },
      });
      const login = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login').send({ username: 'logout-probe', password: 'Admin@123456' }).expect(200);
      const token = login.body.access_token;
      // 用 profile：它不要求任何权限点，能干净地只检验令牌本身是否有效
      await request(app.getHttpServer()).get('/api/v1/admin/auth/profile').set(adminAuth(token)).expect(200);
      await request(app.getHttpServer()).post('/api/v1/admin/auth/logout').set(adminAuth(token)).expect(200);
      const after = await request(app.getHttpServer())
        .get('/api/v1/admin/auth/profile').set(adminAuth(token)).expect(401);
      expect(after.body.code).toBe('TOKEN_INVALID');
    });
  });

  // ==================================================================
  describe('2. 签名、时间戳与防重放', () => {
    const path = '/api/v1/license/policy?app_id=e2e_app';

    it('签名正确时放行', async () => {
      const res = await pluginRequest(app, creds, 'get', path).expect(200);
      expect(res.body.policy.app_status).toBe('active');
    });

    it('签名错误返回 SIGNATURE_INVALID', async () => {
      const res = await pluginRequest(app, creds, 'get', path, undefined, { signature: 'deadbeef' }).expect(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('用错误密钥签名返回 SIGNATURE_INVALID', async () => {
      const res = await pluginRequest(app, creds, 'get', path, undefined, { secret: 'sk_wrong' }).expect(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('Token 错误也返回 SIGNATURE_INVALID，不区分是哪一项出错', async () => {
      const res = await pluginRequest(app, creds, 'get', path, undefined, { token: 'pk_bogus' }).expect(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('时间戳超出窗口返回 TIMESTAMP_EXPIRED', async () => {
      const old = String(Math.floor(Date.now() / 1000) - 3600);
      const res = await pluginRequest(app, creds, 'get', path, undefined, { timestamp: old }).expect(401);
      expect(res.body.code).toBe('TIMESTAMP_EXPIRED');
    });

    it('未来时间戳同样被拒绝', async () => {
      const future = String(Math.floor(Date.now() / 1000) + 3600);
      const res = await pluginRequest(app, creds, 'get', path, undefined, { timestamp: future }).expect(401);
      expect(res.body.code).toBe('TIMESTAMP_EXPIRED');
    });

    it('重复使用同一 nonce 返回 NONCE_REPLAYED', async () => {
      const nonce = `fixed-nonce-${Date.now()}`;
      await pluginRequest(app, creds, 'get', path, undefined, { nonce }).expect(200);
      const res = await pluginRequest(app, creds, 'get', path, undefined, { nonce }).expect(409);
      expect(res.body.code).toBe('NONCE_REPLAYED');
    });

    it('签名失败不会消耗 nonce，改正后同一 nonce 仍可用', async () => {
      const nonce = `retry-nonce-${Date.now()}`;
      await pluginRequest(app, creds, 'get', path, undefined, { nonce, signature: 'bad' }).expect(401);
      await pluginRequest(app, creds, 'get', path, undefined, { nonce }).expect(200);
    });

    it('缺少签名头返回 SIGNATURE_INVALID', async () => {
      const res = await request(app.getHttpServer())
        .get(path).set(adminAuth(creds.token)).expect(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('请求体被篡改会导致验签失败', async () => {
      const body = { app_id: APP_ID, license_key: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', device_id: 'tamper-device-1' };
      const payload = JSON.stringify(body);
      const { signHeaders } = await import('./helpers');
      const headers = signHeaders(creds, 'post', '/api/v1/license/activate', payload);
      const res = await request(app.getHttpServer())
        .post('/api/v1/license/activate').set(headers).set('Content-Type', 'application/json')
        // 签名是按原始 body 算的，这里发一个不同的 body
        .send(JSON.stringify({ ...body, device_id: 'tamper-device-2' }))
        .expect(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });
  });

  // ==================================================================
  describe('3. 卡密激活', () => {
    it('未激活的卡密可以正常激活并返回授权令牌', async () => {
      const { key } = await newLicense();
      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'activate-device-001', client_version: '1.0.0',
      }).expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('active');
      expect(res.body.license_token).toBeTruthy();
      expect(res.body.device_count).toBe(1);
      expect(res.body.device_limit).toBe(2);
      expect(res.body.offline_grace_hours).toBe(48);
      // 到期时间应当是激活后 30 天
      const days = (new Date(res.body.expires_at).getTime() - Date.now()) / 86400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

    it('大小写和分隔符不影响卡密识别', async () => {
      const { key } = await newLicense();
      const messy = key.toLowerCase().replace(/-/g, '');
      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: messy, device_id: 'case-insensitive-001',
      }).expect(200);
      expect(res.body.success).toBe(true);
    });

    it('同一设备重复激活是幂等的，不额外占用名额', async () => {
      const { key } = await newLicense();
      const first = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'idem-device-001',
      }).expect(200);
      const second = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'idem-device-001',
      }).expect(200);
      expect(second.body.device_count).toBe(1);
      expect(second.body.expires_at).toBe(first.body.expires_at);
    });

    it('不存在的卡密返回 LICENSE_NOT_FOUND', async () => {
      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', device_id: 'nonexistent-001',
      }).expect(404);
      expect(res.body.code).toBe('LICENSE_NOT_FOUND');
    });

    it('超过设备上限返回 DEVICE_LIMIT_EXCEEDED', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'limit-device-001',
      }).expect(200);
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'limit-device-002',
      }).expect(200);
      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'limit-device-003',
      }).expect(403);
      expect(res.body.code).toBe('DEVICE_LIMIT_EXCEEDED');
      expect(res.body.details.device_limit).toBe(2);
    });

    it('并发激活不会突破设备上限', async () => {
      const { key } = await newLicense(planNoRebindId); // device_limit = 1
      const attempts = 8;
      const results = await Promise.all(
        Array.from({ length: attempts }, (_, i) =>
          pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
            app_id: APP_ID, license_key: key, device_id: `concurrent-device-${i}`,
          }).then((r) => r.status),
        ),
      );
      const ok = results.filter((s) => s === 200).length;
      expect(ok).toBe(1);
      expect(results.filter((s) => s === 403).length).toBe(attempts - 1);

      // 数据库里也只能有一条绑定记录
      const licenseId = await licenseIdByKey(key);
      const bound = await prisma.licenseDevice.count({ where: { licenseId, status: 'active' } });
      expect(bound).toBe(1);
    });

    it('跨应用使用卡密返回 APP_MISMATCH', async () => {
      const { key } = await newLicense();
      // 用另一个应用的插件去激活本应用的卡密
      const res = await pluginRequest(app, otherCreds, 'post', '/api/v1/license/activate', {
        app_id: OTHER_APP_ID, license_key: key, device_id: 'cross-app-001',
      }).expect(403);
      expect(res.body.code).toBe('APP_MISMATCH');
    });

    it('插件不能操作其绑定应用之外的 app_id', async () => {
      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: OTHER_APP_ID, license_key: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', device_id: 'wrong-app-001',
      }).expect(403);
      expect(res.body.code).toBe('APP_MISMATCH');
    });
  });

  // ==================================================================
  describe('4. 卡密状态流转', () => {
    it('已过期的卡密被拒绝，且状态会落库', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'expire-device-001',
      }).expect(200);

      const licenseId = await licenseIdByKey(key);
      // 直接把到期时间改到过去，模拟自然过期
      await prisma.licenseKey.update({
        where: { id: licenseId }, data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'expire-device-001',
      }).expect(403);
      expect(res.body.code).toBe('LICENSE_EXPIRED');

      const row = await prisma.licenseKey.findUnique({ where: { id: licenseId } });
      expect(row!.status).toBe('expired');
    });

    it('封禁后卡密不可用，且已签发的令牌立即失效', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'ban-device-001',
      }).expect(200);
      const token = act.body.license_token;
      const licenseId = await licenseIdByKey(key);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/ban`).set(adminAuth(superToken))
        .send({ reason: '异常共享' }).expect(200);

      const verify = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID, license_token: token, device_id: 'ban-device-001',
      }).expect(401);
      expect(verify.body.code).toBe('TOKEN_INVALID');

      const reactivate = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'ban-device-001',
      }).expect(403);
      expect(reactivate.body.code).toBe('LICENSE_BANNED');
    });

    it('解封后可以恢复使用', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'unban-device-001',
      }).expect(200);
      const licenseId = await licenseIdByKey(key);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/ban`).set(adminAuth(superToken))
        .send({ reason: '误封测试' }).expect(200);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/unban`).set(adminAuth(superToken)).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'unban-device-001',
      }).expect(200);
      expect(res.body.success).toBe(true);
    });

    it('作废是终态：不可用且不能解封', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'revoke-device-001',
      }).expect(200);
      const licenseId = await licenseIdByKey(key);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/revoke`).set(adminAuth(superToken))
        .send({ reason: '退款' }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'revoke-device-001',
      }).expect(403);
      expect(res.body.code).toBe('LICENSE_REVOKED');

      const unban = await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/unban`).set(adminAuth(superToken)).expect(200);
      expect(unban.body.affected).toBe(0);

      const row = await prisma.licenseKey.findUnique({ where: { id: licenseId } });
      expect(row!.status).toBe('revoked');
    });

    it('过期后续期可以恢复到可用状态', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'renew-device-001',
      }).expect(200);
      const licenseId = await licenseIdByKey(key);
      await prisma.licenseKey.update({
        where: { id: licenseId }, data: { expiresAt: new Date(Date.now() - 1000), status: 'expired' },
      });

      const renew = await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/renew`).set(adminAuth(superToken))
        .send({ days: 30 }).expect(200);
      expect(renew.body.status).toBe('active');

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'renew-device-001',
      }).expect(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==================================================================
  describe('5. 授权验证与令牌', () => {
    it('验证成功会滚动续发新令牌', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'verify-device-001',
      }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'verify-device-001',
      }).expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.license_token).toBeTruthy();
      expect(res.body.policy).toBeTruthy();
    });

    it('令牌与设备不匹配时拒绝', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'bind-device-001',
      }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'someone-elses-device',
      }).expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('伪造的令牌被拒绝', async () => {
      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID,
        license_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.forged',
        device_id: 'forged-token-device',
      }).expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('管理员强制解绑后该设备令牌立即失效', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'force-unbind-001',
      }).expect(200);
      const licenseId = await licenseIdByKey(key);

      const devices = await request(app.getHttpServer())
        .get(`/api/v1/admin/licenses/${licenseId}/devices`).set(adminAuth(superToken)).expect(200);
      const rowId = devices.body.items[0].id;

      await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/devices/${rowId}/unbind`).set(adminAuth(superToken))
        .send({ reason: '客服协助解绑' }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'force-unbind-001',
      }).expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('管理员强制解绑默认不消耗用户换绑次数', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'no-count-rebind-001',
      }).expect(200);
      const licenseId = await licenseIdByKey(key);
      const devices = await request(app.getHttpServer())
        .get(`/api/v1/admin/licenses/${licenseId}/devices`).set(adminAuth(superToken)).expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/licenses/${licenseId}/devices/${devices.body.items[0].id}/unbind`)
        .set(adminAuth(superToken)).send({ reason: '客服解绑' }).expect(200);

      const after = await prisma.licenseKey.findUnique({ where: { id: licenseId } });
      expect(after!.rebindCount).toBe(0);
    });
  });

  // ==================================================================
  describe('6. 换绑规则', () => {
    it('客户端主动解绑消耗一次换绑配额，用尽后被拒绝', async () => {
      const { key } = await newLicense(); // rebind_limit = 2
      for (let i = 1; i <= 3; i++) {
        const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
          app_id: APP_ID, license_key: key, device_id: `rebind-device-${i}`,
        }).expect(200);

        const res = await pluginRequest(app, creds, 'post', '/api/v1/license/deactivate', {
          app_id: APP_ID, license_token: act.body.license_token,
          device_id: `rebind-device-${i}`, reason: '换机器',
        });

        if (i <= 2) {
          expect(res.status).toBe(200);
          expect(res.body.rebind_count).toBe(i);
          expect(res.body.rebind_remaining).toBe(2 - i);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('REBIND_LIMIT_EXCEEDED');
        }
      }
    });

    it('套餐禁止换绑时自助解绑被拒绝', async () => {
      const { key } = await newLicense(planNoRebindId);
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'no-rebind-device-001',
      }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/deactivate', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'no-rebind-device-001',
      }).expect(403);
      expect(res.body.code).toBe('REBIND_NOT_ALLOWED');
    });

    it('未绑定的设备解绑返回 DEVICE_NOT_BOUND', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'bound-device-001',
      }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/deactivate', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'never-bound-device',
      }).expect(404);
      expect(res.body.code).toBe('DEVICE_NOT_BOUND');
    });
  });

  // ==================================================================
  describe('7. 幂等键', () => {
    it('相同幂等键与相同请求体只生效一次', async () => {
      const { key } = await newLicense();
      const idem = `idem-key-${Date.now()}`;
      const body = { app_id: APP_ID, license_key: key, device_id: 'idem-test-001' };

      const first = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', body,
        { idempotencyKey: idem }).expect(200);
      const second = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', body,
        { idempotencyKey: idem }).expect(200);

      // 第二次直接回放首次结果，连令牌都完全一致
      expect(second.body.license_token).toBe(first.body.license_token);
    });

    it('相同幂等键但请求体不同返回 IDEMPOTENCY_CONFLICT', async () => {
      const a = await newLicense();
      const b = await newLicense();
      const idem = `conflict-key-${Date.now()}`;

      await pluginRequest(app, creds, 'post', '/api/v1/license/activate',
        { app_id: APP_ID, license_key: a.key, device_id: 'conflict-001' },
        { idempotencyKey: idem }).expect(200);

      const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate',
        { app_id: APP_ID, license_key: b.key, device_id: 'conflict-002' },
        { idempotencyKey: idem }).expect(409);
      expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('解绑接口的幂等键不会重复扣减换绑次数', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'idem-deact-001',
      }).expect(200);
      const idem = `deact-idem-${Date.now()}`;
      const body = {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'idem-deact-001',
      };

      await pluginRequest(app, creds, 'post', '/api/v1/license/deactivate', body,
        { idempotencyKey: idem }).expect(200);
      await pluginRequest(app, creds, 'post', '/api/v1/license/deactivate', body,
        { idempotencyKey: idem }).expect(200);

      const licenseId = await licenseIdByKey(key);
      const row = await prisma.licenseKey.findUnique({ where: { id: licenseId } });
      expect(row!.rebindCount).toBe(1);
    });
  });

  // ==================================================================
  describe('8. 插件状态与密钥轮换', () => {
    it('插件停用后所有请求被拒绝', async () => {
      const plugin = (await request(app.getHttpServer())
        .post('/api/v1/admin/plugins').set(adminAuth(superToken))
        .send({ application_id: appRowId, plugin_id: 'disable_test_plugin', name: '停用测试' })
        .expect(201)).body;
      const c: PluginCreds = {
        pluginId: plugin.plugin_id, token: plugin.credentials.plugin_token,
        secret: plugin.credentials.plugin_secret,
      };

      await pluginRequest(app, c, 'get', `/api/v1/license/policy?app_id=${APP_ID}`).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/plugins/${plugin.id}`).set(adminAuth(superToken))
        .send({ status: 'disabled' }).expect(200);

      const res = await pluginRequest(app, c, 'get', `/api/v1/license/policy?app_id=${APP_ID}`).expect(403);
      expect(res.body.code).toBe('PLUGIN_DISABLED');
    });

    it('轮换密钥后新旧密钥在宽限期内都能用', async () => {
      const plugin = (await request(app.getHttpServer())
        .post('/api/v1/admin/plugins').set(adminAuth(superToken))
        .send({ application_id: appRowId, plugin_id: 'rotate_test_plugin', name: '轮换测试' })
        .expect(201)).body;
      const oldSecret = plugin.credentials.plugin_secret;
      const c: PluginCreds = {
        pluginId: plugin.plugin_id, token: plugin.credentials.plugin_token, secret: oldSecret,
      };

      const rotated = await request(app.getHttpServer())
        .post(`/api/v1/admin/plugins/${plugin.id}/rotate-secret`).set(adminAuth(superToken))
        .send({ grace_minutes: 60 }).expect(200);

      // 新密钥可用
      await pluginRequest(app, { ...c, secret: rotated.body.plugin_secret }, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}`).expect(200);
      // 宽限期内旧密钥也可用
      await pluginRequest(app, c, 'get', `/api/v1/license/policy?app_id=${APP_ID}`).expect(200);
    });

    it('不设宽限期时旧密钥立即失效', async () => {
      const plugin = (await request(app.getHttpServer())
        .post('/api/v1/admin/plugins').set(adminAuth(superToken))
        .send({ application_id: appRowId, plugin_id: 'rotate_hard_plugin', name: '硬轮换' })
        .expect(201)).body;
      const c: PluginCreds = {
        pluginId: plugin.plugin_id, token: plugin.credentials.plugin_token,
        secret: plugin.credentials.plugin_secret,
      };

      await request(app.getHttpServer())
        .post(`/api/v1/admin/plugins/${plugin.id}/rotate-secret`).set(adminAuth(superToken))
        .send({ grace_minutes: 0 }).expect(200);

      const res = await pluginRequest(app, c, 'get', `/api/v1/license/policy?app_id=${APP_ID}`).expect(401);
      expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('轮换 Token 后旧 Token 立即失效', async () => {
      const plugin = (await request(app.getHttpServer())
        .post('/api/v1/admin/plugins').set(adminAuth(superToken))
        .send({ application_id: appRowId, plugin_id: 'rotate_token_plugin', name: 'Token 轮换' })
        .expect(201)).body;
      const c: PluginCreds = {
        pluginId: plugin.plugin_id, token: plugin.credentials.plugin_token,
        secret: plugin.credentials.plugin_secret,
      };

      const rotated = await request(app.getHttpServer())
        .post(`/api/v1/admin/plugins/${plugin.id}/rotate-token`).set(adminAuth(superToken)).expect(200);

      await pluginRequest(app, { ...c, token: rotated.body.plugin_token }, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}`).expect(200);
      await pluginRequest(app, c, 'get', `/api/v1/license/policy?app_id=${APP_ID}`).expect(401);
    });
  });

  // ==================================================================
  describe('9. 远程管控', () => {
    afterEach(async () => {
      // 每个用例后恢复应用为正常状态，避免污染后续用例
      await prisma.application.update({
        where: { id: appRowId },
        data: {
          status: 'active', killSwitch: false, maintenance: false, minVersion: null,
          forceUpgrade: false, noticeEnabled: false,
        },
      });
    });

    it('一键关停后激活与验证立即被拒绝', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'kill-device-001',
      }).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/applications/${appRowId}/policy`).set(adminAuth(superToken))
        .send({ kill_switch: true, kill_message: '已停止运营' }).expect(200);

      const verify = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'kill-device-001',
      }).expect(403);
      expect(verify.body.code).toBe('APP_KILLED');
      expect(verify.body.message).toBe('已停止运营');

      const activate = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'kill-device-002',
      }).expect(403);
      expect(activate.body.code).toBe('APP_KILLED');
    });

    it('应用停用后激活被拒绝，但策略接口仍可达', async () => {
      const { key } = await newLicense();
      await prisma.application.update({ where: { id: appRowId }, data: { status: 'disabled' } });

      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'disabled-app-device',
      }).expect(403);
      expect(act.body.code).toBe('APP_DISABLED');

      // 策略接口有意不做准入拦截：客户端得能问出「我为什么用不了」
      const policy = await pluginRequest(app, creds, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}`).expect(200);
      expect(policy.body.policy.app_status).toBe('disabled');
    });

    it('维护模式拦新激活但不影响已激活设备验证', async () => {
      const { key } = await newLicense();
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'maint-device-001',
      }).expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/applications/${appRowId}/policy`).set(adminAuth(superToken))
        .send({ maintenance: true, maintenance_message: '维护中' }).expect(200);

      const { key: key2 } = await newLicense();
      const blocked = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key2, device_id: 'maint-device-002',
      }).expect(503);
      expect(blocked.body.code).toBe('APP_MAINTENANCE');

      // 已激活设备照常验证，维护窗口内不会全员掉线
      const verify = await pluginRequest(app, creds, 'post', '/api/v1/license/verify', {
        app_id: APP_ID, license_token: act.body.license_token, device_id: 'maint-device-001',
      }).expect(200);
      expect(verify.body.success).toBe(true);
    });

    it('低于最低版本的客户端被拒绝', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/applications/${appRowId}/policy`).set(adminAuth(superToken))
        .send({ min_version: '2.0.0', upgrade_message: '请升级到 2.0.0' }).expect(200);

      const { key } = await newLicense();
      const low = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'ver-device-001', client_version: '1.9.9',
      }).expect(426);
      expect(low.body.code).toBe('CLIENT_VERSION_TOO_LOW');

      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'ver-device-001', client_version: '2.0.0',
      }).expect(200);
    });

    it('最低版本高于最新版本时拒绝保存，避免把所有客户端锁死', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/applications/${appRowId}/policy`).set(adminAuth(superToken))
        .send({ min_version: '3.0.0', latest_version: '2.0.0' }).expect(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('公告随策略下发', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/applications/${appRowId}/policy`).set(adminAuth(superToken))
        .send({
          notice_enabled: true, notice_level: 'warning',
          notice_title: '今晚维护', notice_content: '23:00-24:00',
        }).expect(200);

      const res = await pluginRequest(app, creds, 'get', `/api/v1/license/policy?app_id=${APP_ID}`).expect(200);
      expect(res.body.policy.notice.level).toBe('warning');
      expect(res.body.policy.notice.title).toBe('今晚维护');
    });

    it('建应用时默认顺带生成一副接入凭据，明文只返回这一次', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/applications').set(adminAuth(superToken))
        .send({ app_id: 'auto_cred_app', name: '自动凭据应用' })
        .expect(201);

      expect(res.body.default_plugin.plugin_id).toBe('auto_cred_app_default');
      expect(res.body.default_plugin.credentials.plugin_token).toMatch(/^pk_/);
      expect(res.body.default_plugin.credentials.plugin_secret).toMatch(/^sk_/);

      // 这副凭据是真能用的
      const c: PluginCreds = {
        pluginId: res.body.default_plugin.plugin_id,
        token: res.body.default_plugin.credentials.plugin_token,
        secret: res.body.default_plugin.credentials.plugin_secret,
      };
      await pluginRequest(app, c, 'get', '/api/v1/license/policy?app_id=auto_cred_app').expect(200);

      // 列表接口不会再吐明文
      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/plugins').query({ application_id: res.body.id })
        .set(adminAuth(superToken)).expect(200);
      expect(JSON.stringify(list.body)).not.toContain(c.secret);
      expect(list.body.items[0].secret_masked).toContain('*');
    });

    it('显式关闭时不生成凭据', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/applications').set(adminAuth(superToken))
        .send({ app_id: 'no_cred_app', name: '不建凭据', with_default_plugin: false })
        .expect(201);
      expect(res.body.default_plugin).toBeNull();
    });

    it('只有具备 application:control 权限才能下发策略', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/applications/${appRowId}/policy`).set(adminAuth(viewerToken))
        .send({ kill_switch: true }).expect(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });
  });

  // ==================================================================
  describe('10. 版本发布与灰度', () => {
    let releaseId: string;

    it('创建版本默认是草稿，草稿不可下载', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId)
        .field('version', '2.5.0')
        .field('release_notes', '测试版本')
        .field('external_url', 'https://example.com/app-2.5.0.exe')
        .expect(201);
      expect(res.body.status).toBe('draft');
      releaseId = res.body.id;

      const dl = await request(app.getHttpServer())
        .get(`/api/v1/releases/${releaseId}/download`).expect(403);
      expect(dl.body.code).toBe('FORBIDDEN');
    });

    it('发布后策略里出现升级信息', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/releases/${releaseId}/publish`).set(adminAuth(superToken))
        .send({ rollout_percent: 100 }).expect(200);

      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}&client_version=1.0.0&device_id=rollout-device-1`).expect(200);
      expect(res.body.policy.upgrade.available).toBe(true);
      expect(res.body.policy.upgrade.latest_version).toBe('2.5.0');
      expect(res.body.policy.upgrade.download_url).toBe('https://example.com/app-2.5.0.exe');
    });

    it('灰度分桶稳定：同一设备多次请求结果一致', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/releases/${releaseId}`).set(adminAuth(superToken))
        .send({ rollout_percent: 50 }).expect(200);

      for (const device of ['stable-a', 'stable-b', 'stable-c']) {
        const versions = new Set<string | null>();
        for (let i = 0; i < 4; i++) {
          const res = await pluginRequest(app, creds, 'get',
            `/api/v1/license/policy?app_id=${APP_ID}&client_version=1.0.0&device_id=${device}`).expect(200);
          versions.add(res.body.policy.upgrade.latest_version);
        }
        expect(versions.size).toBe(1);
      }

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/releases/${releaseId}`).set(adminAuth(superToken))
        .send({ rollout_percent: 100 }).expect(200);
    });

    it('重复版本号被拒绝', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId).field('version', '2.5.0')
        .field('external_url', 'https://example.com/dup.exe')
        .expect(409);
      expect(res.body.code).toBe('CONFLICT');
    });

    it('is_mandatory 传字符串 false 不会被误判为 true', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId).field('version', '2.6.0')
        .field('is_mandatory', 'false')
        .field('external_url', 'https://example.com/app-2.6.0.exe')
        .expect(201);
      expect(res.body.is_mandatory).toBe(false);
    });

    it('删除应用会一并清掉磁盘上的安装包，不留孤儿文件', async () => {
      const fs = await import('fs');
      const path = await import('path');

      const demoApp = (await request(app.getHttpServer())
        .post('/api/v1/admin/applications').set(adminAuth(superToken))
        .send({ app_id: 'orphan_test_app', name: '孤儿文件测试' })
        .expect(201)).body;

      const tmp = path.join(process.env.RELEASE_STORAGE_DIR || './storage/test-releases', 'src.bin');
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, Buffer.alloc(2048, 7));

      const release = (await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', demoApp.id).field('version', '1.0.0')
        .attach('file', tmp)
        .expect(201)).body;

      const storageDir = path.resolve(process.env.RELEASE_STORAGE_DIR || './storage/test-releases');
      const row = await prisma.appRelease.findUnique({ where: { id: release.id } });
      const stored = path.join(storageDir, row!.filePath!);
      expect(fs.existsSync(stored)).toBe(true);

      // app_releases 上挂着 onDelete: Cascade，删应用时数据库会先清掉版本行；
      // 如果不在删除前主动清文件，安装包就会永远留在磁盘上
      await request(app.getHttpServer())
        .delete(`/api/v1/admin/applications/${demoApp.id}`).set(adminAuth(superToken))
        .expect(200);

      expect(fs.existsSync(stored)).toBe(false);
      fs.unlinkSync(tmp);
    });

    it('已发布版本不能直接删除', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/releases/${releaseId}`).set(adminAuth(superToken)).expect(409);
      expect(res.body.code).toBe('CONFLICT');
    });
  });

  // ==================================================================
  describe('11. 卡密存储与导出', () => {
    it('列表接口只返回脱敏卡密，不含明文和密文', async () => {
      await newLicense();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/licenses').query({ page_size: 5 }).set(adminAuth(superToken)).expect(200);

      const raw = JSON.stringify(res.body);
      expect(res.body.items[0].key_masked).toContain('*');
      expect(raw).not.toContain('key_cipher');
      expect(raw).not.toContain('keyCipher');
      expect(raw).not.toContain('key_hash');
    });

    it('数据库里不存明文卡密', async () => {
      const { key } = await newLicense();
      const row = await prisma.licenseKey.findFirst({
        where: { keyHash: { not: '' } }, orderBy: { createdAt: 'desc' },
      });
      expect(row!.keyMasked).toContain('*');
      // 明文既不在脱敏列也不在哈希列里
      expect(row!.keyHash).not.toContain(key.replace(/-/g, ''));
      expect(row!.keyMasked).not.toBe(key);
    });

    it('按前缀搜索命中，且不需要解密', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planMonthId, count: 3, prefix: 'PFX' }).expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/licenses').query({ key_prefix: 'PFX' }).set(adminAuth(superToken)).expect(200);
      expect(res.body.total).toBeGreaterThanOrEqual(3);
      expect(gen.body.keys[0]).toMatch(/^PFX-/);
    });

    it('导出返回明文并写入导出批次与审计日志', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planMonthId, count: 2, note: '导出测试' }).expect(200);

      const before = await prisma.auditLog.count({ where: { action: 'license.export' } });
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/export').set(adminAuth(superToken))
        .send({ batch_id: gen.body.batch_id }).expect(200);

      expect(res.body.count).toBe(2);
      // 导出的 CSV 里必须是可用的明文
      for (const key of gen.body.keys) expect(res.body.csv).toContain(key);

      const after = await prisma.auditLog.count({ where: { action: 'license.export' } });
      expect(after).toBe(before + 1);
      const exportRow = await prisma.licenseKeyExport.findFirst({ orderBy: { createdAt: 'desc' } });
      expect(exportRow!.count).toBe(2);
    });

    it('不带任何筛选条件的全量导出被拒绝', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/export').set(adminAuth(superToken))
        .send({}).expect(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });
  });

  // ==================================================================
  describe('12. 日志与审计', () => {
    it('激活失败也会记入授权日志并带上错误码', async () => {
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: 'YYYYY-YYYYY-YYYYY-YYYYY-YYYYY', device_id: 'log-fail-device',
      }).expect(404);

      const log = await prisma.licenseActivation.findFirst({
        where: { action: 'activate', success: false, code: 'LICENSE_NOT_FOUND' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log!.pluginId).toBe(creds.pluginId);
    });

    it('授权日志接口返回脱敏后的设备指纹', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'a-very-long-device-fingerprint-value',
      }).expect(200);

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/logs/activations').query({ page_size: 5 })
        .set(adminAuth(superToken)).expect(200);

      const entry = res.body.items.find((i: any) => i.device_id?.includes('****'));
      expect(entry).toBeTruthy();
      expect(JSON.stringify(res.body)).not.toContain('a-very-long-device-fingerprint-value');
    });

    it('管理员高危操作写入审计日志，且不含卡密原文', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planMonthId, count: 1 }).expect(200);

      const log = await prisma.auditLog.findFirst({
        where: { action: 'license.generate' }, orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log!.username).toBe('admin');
      expect(JSON.stringify(log!.detail)).not.toContain(gen.body.keys[0]);
    });

    it('插件凭据不会出现在任何日志里', async () => {
      const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'plugin.' } } });
      const dump = JSON.stringify(logs);
      expect(dump).not.toContain(creds.secret);
      expect(dump).not.toContain(creds.token);
    });

    it('API 请求日志记录真实状态码与错误码', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login').send({ username: 'admin', password: 'nope' }).expect(401);

      const log = await prisma.apiRequestLog.findFirst({
        where: { path: '/api/v1/admin/auth/login', statusCode: 401 },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect(log!.code).toBe('BAD_CREDENTIALS');
    });
  });

  // ==================================================================
  describe('13. 状态查询接口', () => {
    it('返回状态但不签发令牌，也不返回卡密明文', async () => {
      const { key } = await newLicense();
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: key, device_id: 'status-device-001',
      }).expect(200);

      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/status?app_id=${APP_ID}&license_key=${encodeURIComponent(key)}&device_id=status-device-001`)
        .expect(200);

      expect(res.body.status).toBe('active');
      expect(res.body.device_bound).toBe(true);
      expect(res.body.license_token).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(key);
    });

    it('缺少定位参数时返回 INVALID_REQUEST', async () => {
      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/status?app_id=${APP_ID}`).expect(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });
  });

  // ==================================================================
  describe('14. 安全加固（黑盒测试回归）', () => {
    it('响应头不暴露 X-Powered-By', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ username: 'admin', password: 'Admin@123456' })
        .expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('超大请求体返回 413 而不是 500', async () => {
      const huge = 'x'.repeat(300 * 1024); // 超过 256KB 限制
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .set('Content-Type', 'application/json')
        .send(`{"username":"${huge}","password":"y"}`);
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('非法 JSON 请求体返回 400 而不是 500', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .set('Content-Type', 'application/json')
        .send('{"username": broken json');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('alg:none 伪造的 JWT 被拒绝', async () => {
      // header={alg:none}, payload 复用真实的，签名段留空
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: superToken, typ: 'access' })).toString('base64url');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/applications')
        .set('Authorization', `Bearer ${header}.${payload}.`)
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('refresh token 不能当作 access token 使用', async () => {
      const login = await request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .send({ username: 'admin', password: 'Admin@123456' })
        .expect(200);
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/applications')
        .set('Authorization', `Bearer ${login.body.refresh_token}`)
        .expect(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('超大分页参数被拒绝', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/licenses?page_size=999999')
        .set(adminAuth(superToken))
        .expect(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('SQL/模板注入载荷不会导致 5xx 或信息泄露', async () => {
      const payloads = ["' OR '1'='1", "'; DROP TABLE license_keys; --", '{{7*7}}'];
      for (const payload of payloads) {
        const res = await request(app.getHttpServer())
          .get('/api/v1/admin/licenses')
          .query({ key_prefix: payload })
          .set(adminAuth(superToken));
        expect(res.status).toBeLessThan(500);
        expect(res.text).not.toMatch(/sql|prisma|syntax error|at Object\./i);
      }
    });

    it('接入文档 context 返回应用上下文但不含 secret', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/docs/context').query({ application_id: appRowId })
        .set(adminAuth(superToken)).expect(200);
      expect(res.body.server_url).toBeTruthy();
      expect(res.body.selected.app_id).toBe(APP_ID);
      // 上下文里绝不能出现密钥
      expect(JSON.stringify(res.body)).not.toMatch(/sk_[A-Za-z0-9_-]{20}/);
    });

    it('在线测试代理由服务端签名，能拿到真实响应', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/docs/playground/invoke').set(adminAuth(superToken))
        .send({ plugin_id: creds.pluginId, action: 'policy',
                query: { app_id: APP_ID, device_id: 'e2e-playground-device' } })
        .expect(200);
      expect(res.body.response.status).toBe(200);
      expect(res.body.response.body.policy.app_status).toBe('active');
      // 回显的签名和 Token 必须脱敏
      expect(res.body.request.headers['X-Signature']).toMatch(/…$/);
      expect(res.body.request.headers.Authorization).toMatch(/\*\*\*\*/);
    });

    it('markdown 接口返回完整接入指南原文', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/docs/markdown').set(adminAuth(superToken)).expect(200);
      expect(res.body.found).toBe(true);
      expect(res.body.content).toContain('# 接入指南');
      expect(res.body.content.length).toBeGreaterThan(1000);
    });

    it('在线测试需要 plugin:write 权限', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/docs/playground/invoke').set(adminAuth(viewerToken))
        .send({ plugin_id: creds.pluginId, action: 'policy', query: { app_id: APP_ID } })
        .expect(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('在线测试只能调白名单动作', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/docs/playground/invoke').set(adminAuth(superToken))
        .send({ plugin_id: creds.pluginId, action: 'delete_everything', query: {} })
        .expect(400);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('生成卡密带渠道时创建批次，列表含核销率', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planMonthId, count: 4, channel: '测试渠道X', note: 'e2e批次' })
        .expect(200);
      expect(gen.body.channel).toBe('测试渠道X');

      // 激活其中一张，制造核销
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'batch-e2e-device',
      }).expect(200);
      expect(act.body.success).toBe(true);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/batches').query({ channel: '测试渠道X' })
        .set(adminAuth(superToken)).expect(200);
      const batch = list.body.items.find((b: any) => b.id === gen.body.batch_id);
      expect(batch).toBeTruthy();
      expect(batch.declared_count).toBe(4);
      expect(batch.stats.used).toBe(1);
      expect(batch.stats.redemption_rate).toBe(25); // 1/4
    });

    it('整批作废把该批未作废卡密全部作废', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planMonthId, count: 3, channel: '盗版渠道' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/batches/${gen.body.batch_id}/revoke-all`).set(adminAuth(superToken))
        .send({ reason: 'e2e：整个渠道盗版' }).expect(200);
      expect(res.body.affected).toBe(3);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/admin/batches/${gen.body.batch_id}`).set(adminAuth(superToken)).expect(200);
      expect(detail.body.stats.counts.revoked).toBe(3);
      expect(detail.body.stats.counts.unused).toBe(0);
    });

    it('经营看板 overview 返回核销率与今日数据', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/analytics/overview').set(adminAuth(superToken)).expect(200);
      expect(res.body).toHaveProperty('total_licenses');
      expect(res.body).toHaveProperty('redemption_rate');
      expect(res.body).toHaveProperty('active_devices');
      expect(res.body.by_status).toHaveProperty('active');
    });

    it('经营看板 trend 补齐每一天，长度与天数一致', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/analytics/trend').query({ days: 7 })
        .set(adminAuth(superToken)).expect(200);
      expect(res.body.days).toBe(7);
      expect(res.body.dates).toHaveLength(7);
      expect(res.body.activations).toHaveLength(7);
      expect(res.body.new_licenses).toHaveLength(7);
      // 补零：即使某天没数据也是 0 而不是缺失
      expect(res.body.activations.every((n: number) => typeof n === 'number')).toBe(true);
    });

    it('看板接口需要 license:read 权限', async () => {
      // viewer 有 license:read，应放行
      await request(app.getHttpServer())
        .get('/api/v1/admin/analytics/overview').set(adminAuth(viewerToken)).expect(200);
    });

    it('配置 webhook 后激活卡密会产生签名投递记录', async () => {
      const crypto = await import('crypto');
      // 建 endpoint（指向必然失败的地址，只验证投递记录与签名，不需要真收）
      const ep = (await request(app.getHttpServer())
        .post('/api/v1/admin/webhooks').set(adminAuth(superToken))
        .send({ application_id: appRowId, url: 'http://127.0.0.1:59998/nowhere' })
        .expect(201)).body;
      expect(ep.secret).toMatch(/^whsec_/); // 密钥只在创建时返回
      expect(ep.secret_masked).toContain('*');

      // 激活一张卡，触发 license.activated 事件
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planMonthId, count: 1 }).expect(200);
      await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'webhook-e2e-device',
      }).expect(200);

      // 事件是异步派发的，给一点时间
      await new Promise((r) => setTimeout(r, 300));

      const deliveries = (await request(app.getHttpServer())
        .get('/api/v1/admin/webhooks/deliveries').query({ endpoint_id: ep.id })
        .set(adminAuth(superToken)).expect(200)).body;
      const d = deliveries.items.find((x: any) => x.event_type === 'license.activated');
      expect(d).toBeTruthy();
      // 投递失败但主流程不受影响：卡密仍是激活状态
      expect(['failed', 'pending', 'dead']).toContain(d.status);
      // payload 不含卡密原文
      expect(JSON.stringify(d.payload)).not.toContain(gen.body.keys[0]);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/webhooks/${ep.id}`).set(adminAuth(superToken)).expect(200);
    });

    it('webhook 配置需要 application:write 权限', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/webhooks').set(adminAuth(viewerToken))
        .send({ application_id: appRowId, url: 'http://x.com/h' }).expect(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('定时清理删除过期记录但保留未过期的', async () => {
      const now = Date.now();
      await prisma.licenseTokenRevocation.createMany({ data: [
        { jti: 'e2e_rev_future', licenseId: 'l', reason: 't', expiresAt: new Date(now + 3600_000) },
        { jti: 'e2e_rev_past', licenseId: 'l', reason: 't', expiresAt: new Date(now - 3600_000) },
      ]});

      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/maintenance/cleanup').set(adminAuth(superToken))
        .expect(200);
      expect(res.body.token_revocations).toBeGreaterThanOrEqual(1);

      // 未过期的绝不能被误删——否则被封的令牌会复活
      expect(await prisma.licenseTokenRevocation.count({ where: { jti: 'e2e_rev_future' } })).toBe(1);
      expect(await prisma.licenseTokenRevocation.count({ where: { jti: 'e2e_rev_past' } })).toBe(0);

      await prisma.licenseTokenRevocation.deleteMany({ where: { jti: { startsWith: 'e2e_rev_' } } });
    });

    it('清理接口需要 admin:write，只读账号被拒', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/maintenance/cleanup').set(adminAuth(viewerToken))
        .expect(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('次数卡：reserve 冻结 → confirm 真扣，可用额度正确', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planCountId, count: 1 }).expect(200);
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'quota-device-1',
      }).expect(200);
      const token = act.body.license_token;

      const r = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-1', amount: 1,
      }).expect(200);
      expect(r.body.quota_available).toBe(4); // 5 冻结1 = 可用4

      const c = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/confirm', {
        app_id: APP_ID, reservation_id: r.body.reservation_id,
      }).expect(200);
      expect(c.body.quota_used).toBe(1);
      expect(c.body.quota_available).toBe(4);
    });

    it('次数卡：并发 reserve 不会超卖', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planCountId, count: 1 }).expect(200);
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'quota-device-race',
      }).expect(200);
      const token = act.body.license_token;

      // 额度5，发起10个并发各扣1
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
          app_id: APP_ID, license_token: token, device_id: 'quota-device-race', amount: 1,
        }).then((r) => r.body)));
      const ok = results.filter((x) => x.success).length;
      const exhausted = results.filter((x) => x.code === 'QUOTA_EXHAUSTED').length;
      expect(ok).toBe(5);          // 恰好5个成功，绝不超卖
      expect(exhausted).toBe(5);
    });

    it('次数卡：幂等键防重复冻结，confirm 幂等', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planCountId, count: 1 }).expect(200);
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'quota-device-idem',
      }).expect(200);
      const token = act.body.license_token;

      const idem = 'consume-idem-key';
      const a = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-idem', amount: 1, request_id: idem,
      }).expect(200);
      const b = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-idem', amount: 1, request_id: idem,
      }).expect(200);
      expect(a.body.reservation_id).toBe(b.body.reservation_id); // 不重复冻结

      await pluginRequest(app, creds, 'post', '/api/v1/license/consume/confirm', {
        app_id: APP_ID, reservation_id: a.body.reservation_id,
      }).expect(200);
      const c2 = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/confirm', {
        app_id: APP_ID, reservation_id: a.body.reservation_id,
      }).expect(200);
      expect(c2.body.replayed).toBe(true); // confirm 幂等
    });

    it('次数卡：release 退回额度，confirm 后不能 release', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planCountId, count: 1 }).expect(200);
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'quota-device-rel',
      }).expect(200);
      const token = act.body.license_token;

      const r = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-rel', amount: 2,
      }).expect(200);
      expect(r.body.quota_available).toBe(3);
      await pluginRequest(app, creds, 'post', '/api/v1/license/consume/release', {
        app_id: APP_ID, reservation_id: r.body.reservation_id,
      }).expect(200);
      // 退回后可用回到5
      const check = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-rel', amount: 1,
      }).expect(200);
      expect(check.body.quota_available).toBe(4);

      // confirm 后不能 release
      await pluginRequest(app, creds, 'post', '/api/v1/license/consume/confirm', {
        app_id: APP_ID, reservation_id: check.body.reservation_id,
      }).expect(200);
      const badRel = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/release', {
        app_id: APP_ID, reservation_id: check.body.reservation_id,
      }).expect(409);
      expect(badRel.body.code).toBe('RESERVATION_NOT_ACTIVE');
    });

    it('次数卡：每台设备独立额度，互不影响', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planCountId, count: 1 }).expect(200);
      // 同一张卡绑两台设备（device_limit=2）
      const act1 = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'multi-dev-A',
      }).expect(200);
      const act2 = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'multi-dev-B',
      }).expect(200);

      // A 用掉2次
      for (let i = 0; i < 2; i++) {
        const r = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
          app_id: APP_ID, license_token: act1.body.license_token, device_id: 'multi-dev-A', amount: 1,
        }).expect(200);
        await pluginRequest(app, creds, 'post', '/api/v1/license/consume/confirm', {
          app_id: APP_ID, reservation_id: r.body.reservation_id,
        }).expect(200);
      }
      // B 的额度应该还是满的5（独立）
      const rB = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: act2.body.license_token, device_id: 'multi-dev-B', amount: 1,
      }).expect(200);
      expect(rB.body.quota_available).toBe(4); // B 冻结1，可用4（不受A影响）
      expect(rB.body.quota_used).toBe(0);
    });

    it('次数卡：过期预扣被定时逻辑释放，额度退回', async () => {
      const gen = await request(app.getHttpServer())
        .post('/api/v1/admin/licenses/generate').set(adminAuth(superToken))
        .send({ plan_id: planCountId, count: 1 }).expect(200);
      const act = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
        app_id: APP_ID, license_key: gen.body.keys[0], device_id: 'quota-device-exp',
      }).expect(200);
      const token = act.body.license_token;

      const r = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-exp', amount: 3,
      }).expect(200);
      expect(r.body.quota_available).toBe(2);

      // 手动把这条预扣改成已过期，然后调过期释放逻辑
      await prisma.licenseReservation.update({
        where: { id: r.body.reservation_id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const consumeService = app.get(ConsumeService);
      const released = await consumeService.releaseExpired();
      expect(released).toBeGreaterThanOrEqual(1);

      // 额度已退回：可用回到5，再预扣看到4
      const check = await pluginRequest(app, creds, 'post', '/api/v1/license/consume/reserve', {
        app_id: APP_ID, license_token: token, device_id: 'quota-device-exp', amount: 1,
      }).expect(200);
      expect(check.body.quota_available).toBe(4);
    });

    it('卡密枚举：连续 30 次「卡密不存在」后触发失败限流', async () => {
      const keys = app.get<RedisService>(RedisService);
      // 清掉本 IP 的失败计数，保证从零开始
      const rk = await keys.raw.keys('rl:activate_miss:*');
      if (rk.length) await keys.raw.del(...rk);

      let limitedAt = 0;
      for (let i = 0; i < 40; i++) {
        const res = await pluginRequest(app, creds, 'post', '/api/v1/license/activate', {
          app_id: APP_ID,
          license_key: `AAAAA-BBBBB-CCCCC-DDDDD-${String(i).padStart(5, '0')}`,
          device_id: `enum-device-${String(i).padStart(4, '0')}`,
        });
        if (res.body.code === 'RATE_LIMITED') { limitedAt = i + 1; break; }
      }
      // 30 次失败即拦（第 31 次请求被拒）
      expect(limitedAt).toBe(31);
    });
  });
  describe('15. 更新包元数据与签名', () => {
    const crypto = require('crypto');
    let signedReleaseId: string;
    let publicKey: string;

    /** 客户端验签：各语言 SDK 复刻的就是这一段。 */
    function verifySignature(
      pubB64: string, appId: string, version: string,
      sha256: string, fileSize: number, sigB64: string,
    ): boolean {
      try {
        const raw = Buffer.from(pubB64, 'base64');
        if (raw.length !== 32) return false;
        const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
        const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
        const payload = ['jc-kami-release-v1', appId, version, sha256, String(fileSize)].join('\n');
        return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sigB64, 'base64'));
      } catch {
        return false;
      }
    }

    it('创建应用即生成验签公钥，且任何接口都不返回私钥', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/applications/${appRowId}`).set(adminAuth(superToken)).expect(200);
      publicKey = res.body.update_sign_public_key;
      expect(Buffer.from(publicKey, 'base64')).toHaveLength(32);
      expect(JSON.stringify(res.body)).not.toMatch(/private/i);
    });

    it('上传时可带包元数据，发布后策略原样下发', async () => {
      const content = Buffer.from('fake-onedir-package-content');
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId)
        .field('version', '3.1.0')
        .field('package_type', 'onedir')
        .field('install_strategy', 'versioned')
        .field('strip_root_dir', 'true')
        .field('entry', 'app.exe')
        .attach('file', content, 'YourApp-3.1.0.zip')
        .expect(201);
      signedReleaseId = created.body.id;
      expect(created.body.package_type).toBe('onedir');
      expect(created.body.install_strategy).toBe('versioned');
      // 草稿阶段还不签名，签名只在发布这一刻产生
      expect(created.body.signed).toBe(false);

      const published = await request(app.getHttpServer())
        .post(`/api/v1/admin/releases/${signedReleaseId}/publish`).set(adminAuth(superToken))
        .send({ rollout_percent: 100 }).expect(200);
      expect(published.body.signed).toBe(true);

      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}&client_version=1.0.0&device_id=pkg-device-1`).expect(200);
      const upgrade = res.body.policy.upgrade;
      expect(upgrade.package).toEqual({
        type: 'onedir', install_strategy: 'versioned',
        strip_root_dir: true, entry: 'app.exe', post_install: null,
      });
      expect(upgrade.signature).toBeTruthy();
    });

    it('下发的签名能被客户端公钥验证通过', async () => {
      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}&client_version=1.0.0&device_id=pkg-device-2`).expect(200);
      const u = res.body.policy.upgrade;
      expect(verifySignature(publicKey, APP_ID, u.latest_version, u.sha256, u.file_size, u.signature))
        .toBe(true);
    });

    it('签名覆盖版本号与哈希：篡改任意一项都验不过', async () => {
      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}&client_version=1.0.0&device_id=pkg-device-3`).expect(200);
      const u = res.body.policy.upgrade;
      // 换包（哈希变了）
      expect(verifySignature(publicKey, APP_ID, u.latest_version, '0'.repeat(64), u.file_size, u.signature))
        .toBe(false);
      // 冒充更高版本，防的是拿旧签名骗新版本的回滚攻击
      expect(verifySignature(publicKey, APP_ID, '9.9.9', u.sha256, u.file_size, u.signature)).toBe(false);
      // 挪用到别的应用
      expect(verifySignature(publicKey, 'other_app', u.latest_version, u.sha256, u.file_size, u.signature))
        .toBe(false);
      // 攻击者用自己的密钥签
      const spki = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
      const foreign = spki.subarray(spki.length - 32).toString('base64');
      expect(verifySignature(foreign, APP_ID, u.latest_version, u.sha256, u.file_size, u.signature))
        .toBe(false);
    });

    it('策略里不下发公钥：公钥必须内置客户端，否则验签形同虚设', async () => {
      const res = await pluginRequest(app, creds, 'get',
        `/api/v1/license/policy?app_id=${APP_ID}&client_version=1.0.0&device_id=pkg-device-4`).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(publicKey);
    });

    it('老应用没有公钥时可补发，且补发是幂等的', async () => {
      // 模拟升级到带签名的版本之前就存在的应用
      await prisma.application.update({
        where: { id: appRowId },
        data: { updateSignPublicKey: null, updateSignPrivateKey: null },
      });

      const first = await request(app.getHttpServer())
        .post(`/api/v1/admin/applications/${appRowId}/sign-key`).set(adminAuth(superToken))
        .expect(201);
      expect(first.body.created).toBe(true);
      expect(Buffer.from(first.body.update_sign_public_key, 'base64')).toHaveLength(32);

      // 再调一次绝不能换钥匙：公钥已经内置进客户端了，换掉就是所有客户端一起验签失败
      const second = await request(app.getHttpServer())
        .post(`/api/v1/admin/applications/${appRowId}/sign-key`).set(adminAuth(superToken))
        .expect(201);
      expect(second.body.created).toBe(false);
      expect(second.body.update_sign_public_key).toBe(first.body.update_sign_public_key);

      publicKey = first.body.update_sign_public_key;
    });

    it('补发密钥需要 application:write 权限', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/admin/applications/${appRowId}/sign-key`).set(adminAuth(viewerToken))
        .expect(403);
    });

    it('包元数据留空时给出安全默认值', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId)
        .field('version', '3.2.0')
        .field('external_url', 'https://example.com/app-3.2.0.zip')
        .expect(201);
      expect(created.body.package_type).toBe('zip');
      expect(created.body.install_strategy).toBe('versioned');
      expect(created.body.strip_root_dir).toBe(false);
    });

    it('外部链接算不出哈希，只能留作未签名，由客户端决定是否接受', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId)
        .field('version', '3.3.0')
        .field('external_url', 'https://example.com/app-3.3.0.zip')
        .expect(201);
      const published = await request(app.getHttpServer())
        .post(`/api/v1/admin/releases/${created.body.id}/publish`).set(adminAuth(superToken))
        .send({}).expect(200);
      expect(published.body.signed).toBe(false);
    });
  });
  describe('16. 分发页', () => {
    const SLUG = 'e2e-dist';
    let ticket: string;

    it('默认不开启，链接名取 app_id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/applications/${appRowId}/dist-site`).set(adminAuth(superToken))
        .expect(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.slug).toBe(APP_ID);
    });

    it('开启后可访问，页面内容来自配置且不含卡密', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/admin/applications/${appRowId}/dist-site`).set(adminAuth(superToken))
        .send({
          enabled: true, slug: SLUG, title: '端到端演示', tagline: '简介一句话',
          intro: '## 步骤\n\n- 解压\n- 双击 **launcher.exe**',
          support_qq: '10000', require_license: true,
        })
        .expect(200);

      const page = await request(app.getHttpServer()).get(`/d/${SLUG}`).expect(200);
      expect(page.headers['content-type']).toContain('html');
      expect(page.text).toContain('端到端演示');
      expect(page.text).toContain('<strong>launcher.exe</strong>');
      expect(page.text).toContain('<li>解压</li>');
    });

    it('页面对配置内容做转义，脚本注入不会被执行', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/admin/applications/${appRowId}/dist-site`).set(adminAuth(superToken))
        .send({ title: '<script>alert(1)</script>', tagline: '"><img src=x onerror=alert(2)>' })
        .expect(200);

      const page = await request(app.getHttpServer()).get(`/d/${SLUG}`).expect(200);
      expect(page.text).not.toContain('<script>alert(1)');
      expect(page.text).not.toContain('<img src=x onerror');
      expect(page.text).toContain('&lt;script&gt;');

      await request(app.getHttpServer())
        .put(`/api/v1/admin/applications/${appRowId}/dist-site`).set(adminAuth(superToken))
        .send({ title: '端到端演示', tagline: '简介一句话' }).expect(200);
    });

    it('上传完整安装包，与更新包各存一份', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/releases').set(adminAuth(superToken))
        .field('application_id', appRowId)
        .field('version', '4.0.0')
        .attach('file', Buffer.from('update-package-body'), 'update-4.0.0.zip')
        .attach('installer', Buffer.from('installer-package-body-longer'), 'Setup-4.0.0.zip')
        .expect(201);
      expect(created.body.has_installer).toBe(true);
      expect(created.body.installer_sha256).not.toBe(created.body.sha256);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/releases/${created.body.id}/publish`).set(adminAuth(superToken))
        .send({}).expect(200);
    });

    it('有效卡密换到票据，凭票据下到的是安装包', async () => {
      const { key } = await newLicense();
      const unlock = await request(app.getHttpServer())
        .post(`/api/v1/pub/dist/${SLUG}/unlock`).send({ license_key: key })
        .expect(200);
      expect(unlock.body.ticket).toBeTruthy();
      ticket = unlock.body.ticket;

      const dl = await request(app.getHttpServer())
        .get(`/api/v1/pub/dist/${SLUG}/download?t=${encodeURIComponent(ticket)}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      // 拿到的必须是安装包，不能是同一版本的更新包
      expect(dl.body.toString()).toBe('installer-package-body-longer');
      expect(dl.headers['content-disposition']).toContain('Setup-4.0.0.zip');
    });

    it('卡密无效时提示统一，不泄露卡密是否存在', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/pub/dist/${SLUG}/unlock`)
        .send({ license_key: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.message).toBe('卡密无效');
    });

    it('票据被篡改或为空一律拒绝', async () => {
      const tampered = ticket.slice(0, -4) + 'AAAA';
      await request(app.getHttpServer())
        .get(`/api/v1/pub/dist/${SLUG}/download?t=${encodeURIComponent(tampered)}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/pub/dist/${SLUG}/download?t=`)
        .expect(403);
    });

    it('关闭后页面与验卡接口一起失效', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/admin/applications/${appRowId}/dist-site`).set(adminAuth(superToken))
        .send({ enabled: false }).expect(200);

      await request(app.getHttpServer()).get(`/d/${SLUG}`).expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/pub/dist/${SLUG}/unlock`).send({ license_key: 'x' })
        .expect(404);
    });

    it('配置分发页需要 application:write 权限', async () => {
      await request(app.getHttpServer())
        .put(`/api/v1/admin/applications/${appRowId}/dist-site`).set(adminAuth(viewerToken))
        .send({ enabled: true }).expect(403);
    });
  });
});
