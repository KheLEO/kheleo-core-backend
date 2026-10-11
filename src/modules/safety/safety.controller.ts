import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { SafetyService } from './safety.service';
import { TelemetryWebhookDto, TelemetryResponseDto } from './dto/telemetry-webhook.dto';

@Controller('safety')
export class SafetyController {
  constructor(private readonly safetyService: SafetyService) {}

  @Post('telemetry-webhook')
  @HttpCode(HttpStatus.OK)
  async handleTelemetryWebhook(
    @Body() dto: TelemetryWebhookDto,
  ): Promise<TelemetryResponseDto> {
    return this.safetyService.processTelemetry(dto);
  }
}
