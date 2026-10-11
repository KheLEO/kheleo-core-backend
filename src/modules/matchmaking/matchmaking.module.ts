import { Module } from '@nestjs/common';
import { MatchmakingController } from './matchmaking.controller';
import { MatchmakingService } from './matchmaking.service';
import { MatchmakingProcessor } from './processors/matchmaking.processor';
import { MatchmakingGateway } from './matchmaking.gateway';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { BullmqModule } from '../../infrastructure/queues/bullmq.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, BullmqModule, AuthModule],
  controllers: [MatchmakingController],
  providers: [MatchmakingService, MatchmakingProcessor, MatchmakingGateway],
  exports: [MatchmakingService, MatchmakingGateway],
})
export class MatchmakingModule {}
