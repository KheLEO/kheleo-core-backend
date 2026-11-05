import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';

interface GtiBounds {
  readonly minGti: number;
  readonly maxGti: number;
}

interface TournamentInvariants extends GtiBounds {
  readonly prizePool: number;
  readonly maxTeams: number;
  readonly teamSize: number;
  readonly venueLat: number;
  readonly venueLng: number;
  readonly registrationDeadline: Date;
  readonly startDate: Date;
  readonly endDate: Date;
}

export function assertTournamentOwner(organizerId: string, actor: AuthenticatedJwtUser): void {
  const admin = actor.role === UserRole.SUPER_ADMIN || actor.role === UserRole.FEDERATION_ADMIN;
  if (!admin && (actor.role !== UserRole.ORGANIZER || organizerId !== actor.sub)) {
    throw new ForbiddenException('You do not own this tournament');
  }
}

export function assertGtiBounds(bounds: GtiBounds): void {
  if (
    !Number.isFinite(bounds.minGti) ||
    !Number.isFinite(bounds.maxGti) ||
    bounds.minGti < 0 ||
    bounds.maxGti > 100 ||
    bounds.minGti > bounds.maxGti
  ) {
    throw new BadRequestException('GTI bounds must satisfy 0 <= minGti <= maxGti <= 100');
  }
}

export function assertBracketInvariants(
  bounds: GtiBounds & { readonly entryFee: number; readonly maxTeams: number },
): void {
  assertGtiBounds(bounds);
  if (!Number.isFinite(bounds.entryFee) || bounds.entryFee < 0)
    throw new BadRequestException('entryFee must be non-negative');
  if (!Number.isInteger(bounds.maxTeams) || bounds.maxTeams < 2)
    throw new BadRequestException('maxTeams must be at least 2');
}

export function assertTournamentInvariants(value: TournamentInvariants): void {
  assertGtiBounds(value);
  if (!Number.isFinite(value.prizePool) || value.prizePool < 0)
    throw new BadRequestException('prizePool must be non-negative');
  if (!Number.isInteger(value.maxTeams) || value.maxTeams < 2)
    throw new BadRequestException('maxTeams must be at least 2');
  if (!Number.isInteger(value.teamSize) || value.teamSize < 1 || value.teamSize > 30)
    throw new BadRequestException('teamSize must be between 1 and 30');
  if (
    !Number.isFinite(value.venueLat) ||
    Math.abs(value.venueLat) > 90 ||
    !Number.isFinite(value.venueLng) ||
    Math.abs(value.venueLng) > 180
  )
    throw new BadRequestException('Venue coordinates are out of bounds');
  const dates = [value.registrationDeadline, value.startDate, value.endDate].map((date) =>
    date.getTime(),
  );
  if (!dates.every(Number.isFinite) || dates[0]! > dates[1]! || dates[1]! > dates[2]!) {
    throw new BadRequestException(
      'Dates must satisfy registrationDeadline <= startDate <= endDate',
    );
  }
}
