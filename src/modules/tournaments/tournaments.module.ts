import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';
import { MatchmakingModule } from '../matchmaking/matchmaking.module';
import { Module } from '@nestjs/common';
import { TournamentsController } from './tournaments.controller';
import { TournamentsService } from './tournaments.service';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuthModule } from '../auth/auth.module';

import { MatchResultsController } from './match-results.controller';
import { MatchResultsService } from './match-results.service';

@Module({
  imports: [PrismaModule, AuthModule, MatchmakingModule],
  controllers: [OrganizerController, TournamentsController, MatchResultsController],
  providers: [OrganizerService, TournamentsService, MatchResultsService],
  exports: [TournamentsService],
})
export class TournamentsModule {}
