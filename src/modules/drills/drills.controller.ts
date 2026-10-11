import {
  Controller,
  Post,
  Body,
  Headers,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { DrillsService, DrillSubmissionResult } from './drills.service';
import { SubmitDrillDto } from './dto/submit-drill.dto';
import { DrillSignatureGuard } from './guards/drill-signature.guard';

@Controller('drills')
export class DrillsController {
  constructor(private readonly drillsService: DrillsService) {}

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(DrillSignatureGuard)
  async submit(
    @Body() dto: SubmitDrillDto,
    @Headers('x-drill-signature') drillSignature: string | undefined,
    @Headers('x-device-signature') deviceSignature: string | undefined,
    @Req() req: FastifyRequest,
  ): Promise<DrillSubmissionResult> {
    const user = (req as FastifyRequest & { user?: { sub: string } }).user;
    const athleteId = dto.athlete_id || user?.sub || '';
    const signature = drillSignature || deviceSignature || '';

    return this.drillsService.submitDrill(athleteId, dto, signature);
  }
}
