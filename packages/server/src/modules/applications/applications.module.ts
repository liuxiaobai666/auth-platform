import { Module } from '@nestjs/common';
import { PluginsModule } from '../plugins/plugins.module';
import { ReleasesModule } from '../releases/releases.module';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

@Module({
  imports: [PluginsModule, ReleasesModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
