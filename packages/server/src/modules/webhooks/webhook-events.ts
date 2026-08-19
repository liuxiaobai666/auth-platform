/**
 * Webhook 事件类型，对齐 DEVELOPMENT.md 8.10。
 * 业务动作发生时通过 EventEmitter 发出，webhook 模块监听并推送给订阅的应用。
 */
export const WEBHOOK_EVENTS = {
  LICENSE_ACTIVATED: 'license.activated',
  LICENSE_BANNED: 'license.banned',
  LICENSE_UNBANNED: 'license.unbanned',
  LICENSE_REVOKED: 'license.revoked',
  LICENSE_RENEWED: 'license.renewed',
  DEVICE_BOUND: 'license.device_bound',
  DEVICE_UNBOUND: 'license.device_unbound',
} as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

export const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);

/** 内部事件总线上的事件名（所有 webhook 事件走同一个通道，data 里带 type）。 */
export const WEBHOOK_EMIT = 'webhook.dispatch';

export interface WebhookEventPayload {
  applicationId: string;
  type: WebhookEventType;
  /** 事件数据，不含卡密原文、令牌、完整设备指纹 */
  data: Record<string, unknown>;
}
