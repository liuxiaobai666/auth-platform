/**
 * 权限点清单。对应 DEVELOPMENT.md 第 5 章，并为远程管控与版本发布补充了新的权限。
 * 权限校验一律在服务端执行，前端隐藏按钮只是体验优化，不是安全边界。
 */
export const Permission = {
  APPLICATION_READ: 'application:read',
  APPLICATION_WRITE: 'application:write',
  /** 远程熔断、维护模式、版本策略、公告等高危管控动作 */
  APPLICATION_CONTROL: 'application:control',

  PLUGIN_READ: 'plugin:read',
  PLUGIN_WRITE: 'plugin:write',

  PLAN_READ: 'plan:read',
  PLAN_WRITE: 'plan:write',

  LICENSE_READ: 'license:read',
  LICENSE_WRITE: 'license:write',
  LICENSE_BAN: 'license:ban',
  LICENSE_UNBIND: 'license:unbind',
  /** 导出明文卡密，高危，单独授权 */
  LICENSE_EXPORT: 'license:export',

  RELEASE_READ: 'release:read',
  RELEASE_WRITE: 'release:write',

  AUDIT_READ: 'audit:read',

  ADMIN_READ: 'admin:read',
  ADMIN_WRITE: 'admin:write',
} as const;

export type PermissionValue = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: string[] = Object.values(Permission);

/** 内置角色。超级管理员不走角色，直接拥有全部权限。 */
export const BUILTIN_ROLES = [
  {
    code: 'operator',
    name: '运营管理员',
    description: '日常发卡与客服处理，不能改应用配置和远程管控',
    permissions: [
      Permission.APPLICATION_READ,
      Permission.PLAN_READ,
      Permission.LICENSE_READ,
      Permission.LICENSE_WRITE,
      Permission.LICENSE_BAN,
      Permission.LICENSE_UNBIND,
      Permission.RELEASE_READ,
      Permission.AUDIT_READ,
    ],
  },
  {
    code: 'developer',
    name: '开发管理员',
    description: '负责应用接入、插件密钥与版本发布',
    permissions: [
      Permission.APPLICATION_READ,
      Permission.APPLICATION_WRITE,
      Permission.PLUGIN_READ,
      Permission.PLUGIN_WRITE,
      Permission.PLAN_READ,
      Permission.PLAN_WRITE,
      Permission.LICENSE_READ,
      Permission.RELEASE_READ,
      Permission.RELEASE_WRITE,
      Permission.AUDIT_READ,
    ],
  },
  {
    code: 'viewer',
    name: '只读管理员',
    description: '只能查看，不能做任何写操作',
    permissions: [
      Permission.APPLICATION_READ,
      Permission.PLUGIN_READ,
      Permission.PLAN_READ,
      Permission.LICENSE_READ,
      Permission.RELEASE_READ,
      Permission.AUDIT_READ,
    ],
  },
];
