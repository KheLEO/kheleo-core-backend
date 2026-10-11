import { Module } from '@nestjs/common';
import { GtiService } from './gti.service';
import { GtiController } from './gti.controller';
import { GtiCalculationProcessor } from './processors/gti-calculation.processor';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [GtiController],
  providers: [GtiService, GtiCalculationProcessor],
  exports: [GtiService],
})
export class GtiModule {}
