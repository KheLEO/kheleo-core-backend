import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HealthModule } from '../health/health.module';
import { LeaderboardsModule } from '../leaderboards/leaderboards.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
@Module({
  imports: [AuthModule, HealthModule, LeaderboardsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
