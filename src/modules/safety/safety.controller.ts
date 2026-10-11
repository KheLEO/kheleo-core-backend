import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SafetyService } from './safety.service';
import { TelemetryWebhookDto, TelemetryResponseDto } from './dto/telemetry-webhook.dto';
import { HmacTamperGuard } from '../../common/guards/hmac-tamper.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';

@Controller('safety')
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  @Post('telemetry-webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(HmacTamperGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async handleTelemetryWebhook(@Body() dto: TelemetryWebhookDto): Promise<TelemetryResponseDto> {
    return this.safetyService.processTelemetry(dto);
  }
}
