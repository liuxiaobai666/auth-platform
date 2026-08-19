import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'route:public';
/** 标记路由无需管理员登录态。 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'route:permissions';
/** 声明访问该路由所需的权限点，多个之间是「全部满足」。 */
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS_KEY, perms);

export const AUDIT_KEY = 'route:audit';
export interface AuditMeta {
  action: string;
  targetType?: string;
}
/** 声明该路由需要写审计日志。 */
export const Audit = (action: string, targetType?: string) =>
  SetMetadata(AUDIT_KEY, { action, targetType } as AuditMeta);

export interface AdminPrincipal {
  id: string;
  username: string;
  isSuperAdmin: boolean;
  permissions: string[];
}

export const CurrentAdmin = createParamDecorator((data: keyof AdminPrincipal | undefined, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const admin: AdminPrincipal | undefined = req.admin;
  return data ? admin?.[data] : admin;
});

export interface PluginPrincipal {
  id: string;
  pluginId: string;
  applicationId: string;
  appId: string;
  status: string;
}

export const CurrentPlugin = createParamDecorator((data: keyof PluginPrincipal | undefined, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  const plugin: PluginPrincipal | undefined = req.plugin;
  return data ? plugin?.[data] : plugin;
});
