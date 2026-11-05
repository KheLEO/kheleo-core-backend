import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';

@Injectable()
export class RoomAccessService {
  constructor(private readonly prisma: PrismaService) {}
  async canJoin(
    actor: AuthenticatedJwtUser | undefined,
    scope: 'match' | 'bracket' | 'tournament',
    id: string,
  ): Promise<boolean> {
    if (!actor || typeof id !== 'string' || !isUUID(id)) return false;
    if ([UserRole.SUPER_ADMIN, UserRole.FEDERATION_ADMIN].some((role) => role === actor.role))
      return true;
    if (actor.role === UserRole.ORGANIZER) {
      if (scope === 'match')
        return !!(await this.prisma.match.findFirst({
          where: { id, bracket: { tournament: { organizerId: actor.sub } } },
          select: { id: true },
        }));
      if (scope === 'bracket')
        return !!(await this.prisma.bracket.findFirst({
          where: { id, tournament: { organizerId: actor.sub } },
          select: { id: true },
        }));
      return !!(await this.prisma.tournament.findFirst({
        where: { id, organizerId: actor.sub },
        select: { id: true },
      }));
    }
    if (actor.role === UserRole.UMPIRE) {
      if (scope === 'match')
        return !!(await this.prisma.match.findFirst({
          where: { id, umpireId: actor.sub },
          select: { id: true },
        }));
      if (scope === 'bracket')
        return !!(await this.prisma.bracket.findFirst({
          where: { id, matches: { some: { umpireId: actor.sub } } },
          select: { id: true },
        }));
    }
    return false;
  }
}
