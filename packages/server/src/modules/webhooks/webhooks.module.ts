import { Module } from '@nestjs/common';
import { EndpointsService } from './endpoints.service';
import { WebhookRetryTask } from './webhook-retry.task';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, EndpointsService, WebhookRetryTask],
  exports: [WebhooksService],
})
export class WebhooksModule {}
