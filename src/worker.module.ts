import { Module } from '@nestjs/common';
import { ConfigurationModule } from './config/configuration.module';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { RedisModule } from './infrastructure/cache/redis.module';
import { BullmqModule } from './infrastructure/queues/bullmq.module';
import { RealtimeModule } from './infrastructure/realtime/realtime.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { LeaderboardsModule } from './modules/leaderboards/leaderboards.module';
import { GtiModule, GtiWorkersModule } from './modules/gti/gti.module';
import {
  MatchmakingModule,
  MatchmakingWorkersModule,
} from './modules/matchmaking/matchmaking.module';
import { OutboxDispatcher } from './infrastructure/outbox/outbox-dispatcher.service';

/**
 * Headless background-worker module running OutboxDispatcher and BullMQ
 * processors (GTI calculation, scout alerts, matchmaking) without binding an
 * HTTP or WebSocket port. Real-time events emitted by workers are relayed to
 * HTTP/WS API instances over Redis Pub/Sub via RedisWsBridge.
 */
@Module({
  providers: [OutboxDispatcher],
  imports: [
    ConfigurationModule,
    PrismaModule,
    RedisModule,
    BullmqModule,
    RealtimeModule,
    CommonModule,
    AuthModule,
    LeaderboardsModule,
    GtiModule,
    GtiWorkersModule,
    MatchmakingModule,
    MatchmakingWorkersModule,
  ],
})
export class WorkerModule {}

