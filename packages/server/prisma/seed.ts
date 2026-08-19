/**
 * 初始化数据：内置角色 + 超级管理员。
 * 可重复执行，已存在的记录只更新不重建。
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { BUILTIN_ROLES } from '../src/common/auth/permissions';

const prisma = new PrismaClient();

const genId = (prefix: string) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

async function main() {
  for (const role of BUILTIN_ROLES) {
    await prisma.adminRole.upsert({
      where: { code: role.code },
      update: {
        name: role.name,
        description: role.description,
        permissions: role.permissions as any,
      },
      create: {
        id: genId('rol'),
        code: role.code,
        name: role.name,
        description: role.description,
        permissions: role.permissions as any,
        isBuiltin: true,
      },
    });
    console.log(`角色就绪: ${role.code} (${role.permissions.length} 个权限)`);
  }

  const username = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@123456';

  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    console.log(`超级管理员已存在，跳过创建: ${username}`);
  } else {
    await prisma.adminUser.create({
      data: {
        id: genId('usr'),
        username,
        passwordHash: await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        }),
        nickname: '超级管理员',
        isSuperAdmin: true,
        status: 'active',
      },
    });
    console.log('─'.repeat(52));
    console.log(`超级管理员已创建`);
    console.log(`  用户名: ${username}`);
    console.log(`  密码:   ${password}`);
    console.log(`  请登录后立即通过「修改密码」更换`);
    console.log('─'.repeat(52));
  }
}

main()
  .catch((e) => {
    console.error('初始化失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
