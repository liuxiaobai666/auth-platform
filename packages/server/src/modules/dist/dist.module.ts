import { Module } from '@nestjs/common';
import { DistPublicController } from './dist-public.controller';
import { DistController } from './dist.controller';
import { DistService } from './dist.service';

@Module({
  controllers: [DistController, DistPublicController],
  providers: [DistService],
  exports: [DistService],
})
export class DistModule {}
