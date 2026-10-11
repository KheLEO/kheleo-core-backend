import { Module } from '@nestjs/common';
import { ConfigurationModule } from './config/configuration.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/cache/redis.module';
import { BullmqModule } from './infrastructure/queues/bullmq.module';
import { RealtimeModule } from './infrastructure/realtime/realtime.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { IdentityModule } from './modules/identity/identity.module';
import { PassportModule } from './modules/passport/passport.module';
import { TournamentsModule } from './modules/tournaments/tournaments.module';
import { BracketsModule } from './modules/brackets/brackets.module';
import { MatchmakingModule } from './modules/matchmaking/matchmaking.module';
import { DrillsModule } from './modules/drills/drills.module';
import { SafetyModule } from './modules/safety/safety.module';
import { GtiModule } from './modules/gti/gti.module';
import { ScoutsModule } from './modules/scouts/scouts.module';
import { HeatmapsModule } from './modules/heatmaps/heatmaps.module';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    // Infrastructure
    ConfigurationModule,
    PrismaModule,
    RedisModule,
    BullmqModule,
    RealtimeModule,
    CommonModule,

    // Domain Modules
    AuthModule,
    UsersModule,
    IdentityModule,
    PassportModule,
    TournamentsModule,
    BracketsModule,
    MatchmakingModule,
    DrillsModule,
    SafetyModule,
    GtiModule,
    ScoutsModule,
    HeatmapsModule,
  ],
})
export class AppModule {}
