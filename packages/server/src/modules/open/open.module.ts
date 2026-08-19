import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OpenController } from './open.controller';
import { PluginSignatureGuard } from './guards/plugin-signature.guard';
import { ActivationService } from './services/activation.service';
import { IdempotencyService } from './services/idempotency.service';
import { LicenseTokenService } from './services/license-token.service';
import { PolicyService } from './services/policy.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [OpenController],
  providers: [
    PluginSignatureGuard,
    ActivationService,
    IdempotencyService,
    LicenseTokenService,
    PolicyService,
  ],
  exports: [LicenseTokenService, PolicyService, IdempotencyService],
})
export class OpenModule {}
