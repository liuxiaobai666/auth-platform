import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { clientIp, userAgent } from '../utils/request.util';

export interface AuditInput {
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/**
 * 管理员操作日志。封禁、作废、解绑、导出、密钥轮换、远程管控这些动作
 * 必须留痕，且 detail 里不允许出现卡密原文、Token 或完整设备指纹。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async record(req: Request, input: AuditInput): Promise<void> {
    const admin = (req as any).admin;
    try {
      await this.prisma.auditLog.create({
        data: {
          id: this.crypto.genId('aud'),
          adminUserId: admin?.id ?? null,
          username: admin?.username ?? null,
          action: input.action,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          detail: (input.detail ?? {}) as any,
          ip: clientIp(req),
          userAgent: userAgent(req),
        },
      });
    } catch (e) {
      // 审计写入失败要留痕告警，但不能因此让业务操作回滚
      this.logger.error(`审计日志写入失败: ${(e as Error).message}`);
    }
  }
}
