import { Module } from '@nestjs/common';
import { ScoutsController } from './scouts.controller';
import { ScoutsService } from './scouts.service';
import { AuthModule } from '../auth/auth.module';
import { ScoutsDossiersService } from './dossiers.service';
import { ScoutOutreachGuard } from './scout-outreach.guard';

@Module({
  imports: [AuthModule],
  controllers: [ScoutsController],
  providers: [ScoutsService, ScoutsDossiersService, ScoutOutreachGuard],
  exports: [ScoutsService, ScoutsDossiersService],
})
export class ScoutsModule {}
