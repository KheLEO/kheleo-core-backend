import { Module } from '@nestjs/common';
import { LeaderboardsService } from './leaderboards.service';
@Module({ providers: [LeaderboardsService], exports: [LeaderboardsService] })
export class LeaderboardsModule {}
