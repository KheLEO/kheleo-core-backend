import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaModule } from '../../infrastructure/database/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PassportModule } from '../passport/passport.module';
import { ScoutsModule } from '../scouts/scouts.module';

import { LeaderboardsModule } from '../leaderboards/leaderboards.module';

@Module({
  imports: [LeaderboardsModule, PrismaModule, AuthModule, PassportModule, ScoutsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
