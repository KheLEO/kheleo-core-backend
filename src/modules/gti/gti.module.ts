import { Module } from '@nestjs/common';
import { GtiService } from './gti.service';
import { GtiController } from './gti.controller';
import { GtiRecalculationProcessor } from './processors/gti.processor';
import { GtiCalculationProcessor } from './processors/gti-calculation.processor';

@Module({
  controllers: [GtiController],
  providers: [
    GtiService,
    GtiRecalculationProcessor,
    GtiCalculationProcessor,
  ],
  exports: [GtiService],
})
export class GtiModule {}
