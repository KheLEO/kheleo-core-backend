import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MatchmakingController } from './matchmaking.controller';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingProcessor } from './processors/matchmaking.processor';
import { MatchmakingGateway } from './matchmaking.gateway';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { BullmqModule } from '../../infrastructure/queues/bullmq.module';
import { QUEUE_MATCHMAKING } from '../../common/constants/queue.constants';

@Module({
  imports: [
    PrismaModule,
    BullmqModule,
    BullModule.registerQueue({ name: QUEUE_MATCHMAKING }),
  ],
  controllers: [MatchmakingController],
  providers: [MatchmakingService, MatchmakingProcessor, MatchmakingGateway],
  exports: [MatchmakingService, MatchmakingGateway],
})
export class MatchmakingModule {}
