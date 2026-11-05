import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { FastifyRequest } from 'fastify';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { assertDossierVisibility } from './dossiers.service';

interface OutreachRequest extends FastifyRequest {
  readonly user: AuthenticatedJwtUser;
  readonly params: { readonly athleteId: string };
}

@Injectable()
export class ScoutOutreachGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OutreachRequest>();
    if (!isUUID(request.params.athleteId))
      throw new BadRequestException('athleteId must be a UUID');
    const profile = await this.prisma.athleteProfile.findUnique({
      where: { userId: request.params.athleteId },
      select: { isScoutSearchable: true },
    });
    if (!profile) throw new NotFoundException('Athlete passport not found');
    assertDossierVisibility(request.params.athleteId, profile.isScoutSearchable, request.user);
    return true;
  }
}
