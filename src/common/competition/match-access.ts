import { ForbiddenException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuthenticatedJwtUser } from '../guards/jwt-auth.guard';

export const matchContextSelect = {
  id: true,
  bracketId: true,
  status: true,
  umpireId: true,
  teamAId: true,
  teamBId: true,
  bracket: { select: { tournamentId: true, tournament: { select: { organizerId: true } } } },
  teamA: {
    select: { members: { select: { userId: true, athlete: { select: { userId: true } } } } },
  },
  teamB: {
    select: { members: { select: { userId: true, athlete: { select: { userId: true } } } } },
  },
} as const satisfies Prisma.MatchSelect;
export type MatchContext = Prisma.MatchGetPayload<{ select: typeof matchContextSelect }>;

export function assertMatchOperator(
  actor: AuthenticatedJwtUser,
  organizerId: string,
  match?: MatchContext,
): void {
  if (actor.role === UserRole.SUPER_ADMIN) return;
  if (actor.role === UserRole.ORGANIZER && actor.sub === organizerId) return;
  if (actor.role === UserRole.UMPIRE && match?.umpireId === actor.sub) return;
  throw new ForbiddenException('Match access requires the owning organizer or assigned umpire');
}

export function teamParticipants(members: MatchContext['teamA']['members']): string[] {
  return members
    .map((member) => member.userId ?? member.athlete?.userId)
    .filter((id): id is string => typeof id === 'string');
}

export function matchParticipants(match: MatchContext): string[] {
  return [...new Set(teamParticipants([...match.teamA.members, ...match.teamB.members]))];
}
