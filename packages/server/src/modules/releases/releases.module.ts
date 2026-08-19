import { Module } from '@nestjs/common';
import { ReleaseDownloadController, ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  controllers: [ReleasesController, ReleaseDownloadController],
  providers: [ReleasesService],
  exports: [ReleasesService],
})
export class ReleasesModule {}
