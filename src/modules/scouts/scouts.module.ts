import { Module } from '@nestjs/common';
import { ScoutsController } from './scouts.controller';
import { ScoutsService } from './scouts.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ScoutsController],
  providers: [ScoutsService],
  exports: [ScoutsService],
})
export class ScoutsModule {}
