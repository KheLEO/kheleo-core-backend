import {
  Controller,
  Post,
  Body,
  Headers,
  UseGuards,
  UseInterceptors,
  Req,
  ForbiddenException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { DrillsService, DrillSubmissionResult } from './drills.service';
import { SubmitDrillDto } from './dto/submit-drill.dto';
import { DrillRequest, DrillSignatureGuard } from './guards/drill-signature.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';

@Controller('drills')
export class DrillsController {
  constructor(private readonly drillsService: DrillsService) {}

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, DrillSignatureGuard)
  @Roles(UserRole.ATHLETE)
  @UseInterceptors(IdempotencyInterceptor)
  async submit(
    @Body() dto: SubmitDrillDto,
    @Headers('x-drill-signature') drillSignature: string | undefined,
    @Req() req: DrillRequest,
  ): Promise<DrillSubmissionResult> {
    const user = (req as FastifyRequest & { user?: { sub: string } }).user;
    if (!user) {
      throw new ForbiddenException('Authenticated athlete identity is required.');
    }
    if (dto.athlete_id && dto.athlete_id !== user.sub) {
      throw new ForbiddenException('Drill athlete_id must match the authenticated user.');
    }

    return this.drillsService.submitDrill(
      user.sub,
      dto,
      drillSignature ?? '',
      req.drillSignatureVersion,
    );
  }
}
