import { Module } from '@nestjs/common';
import { SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';
import { HmacTamperGuard } from '../../common/guards/hmac-tamper.guard';

@Module({
  controllers: [SafetyController],
  providers: [SafetyService, HmacTamperGuard],
  exports: [SafetyService],
})
export class SafetyModule {}
