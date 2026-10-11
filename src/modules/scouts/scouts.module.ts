import { Module } from '@nestjs/common';
import { ScoutsController } from './scouts.controller';
import { ScoutsService } from './scouts.service';

@Module({
  controllers: [ScoutsController],
  providers: [ScoutsService],
  exports: [ScoutsService],
})
export class ScoutsModule {}
