import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';
import { HmacTamperGuard } from '../../common/guards/hmac-tamper.guard';

import { AuthModule } from '../auth/auth.module';
import { TelemetryAuthGuard } from './telemetry-auth.guard';

@Module({
  imports: [AuthModule],
  controllers: [SafetyController],
  providers: [SafetyService, HmacTamperGuard, TelemetryAuthGuard],
  exports: [SafetyService],
})
export class SafetyModule {}
