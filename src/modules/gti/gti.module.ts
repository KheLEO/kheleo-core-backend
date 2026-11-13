import { Module } from '@nestjs/common';
import { GtiService } from './gti.service';
import { GtiController } from './gti.controller';
import { GtiCalculationProcessor } from './processors/gti-calculation.processor';
import { AuthModule } from '../auth/auth.module';
import { ScoutAlertsProcessor } from './processors/scout-alerts.processor';
import { LeaderboardsModule } from '../leaderboards/leaderboards.module';

@Module({
  imports: [AuthModule, LeaderboardsModule],
  controllers: [GtiController],
  providers: [GtiService, GtiCalculationProcessor, ScoutAlertsProcessor],
  exports: [GtiService],
})
export class GtiModule {}

@Module({
  imports: [GtiModule, LeaderboardsModule],
  providers: [],
})
export class GtiWorkersModule {}
