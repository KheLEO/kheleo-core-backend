import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, TournamentStatus } from '@prisma/client';
import { assertAccountAccess } from '../../common/auth/account-access';

export const participationProfileSelect = {
  id: true,
  userId: true,
  currentGti: true,
  dateOfBirth: true,
  gender: true,
  primarySport: true,
  district: true,
  state: true,
  user: { select: { isActive: true, identityRecord: { select: { status: true } } } },
} satisfies Prisma.AthleteProfileSelect;

export const participationBracketSelect = {
  id: true,
  tournamentId: true,
  tierName: true,
  config: true,
  minGti: true,
  maxGti: true,
  maxTeams: true,
  entryFee: true,
  tournament: {
    select: {
      id: true,
      sport: true,
      teamSize: true,
      status: true,
      registrationDeadline: true,
      rulesConfig: true,
    },
  },
} satisfies Prisma.BracketSelect;

export type ParticipationProfile = Prisma.AthleteProfileGetPayload<{
  select: typeof participationProfileSelect;
}>;
export type ParticipationBracket = Prisma.BracketGetPayload<{
  select: typeof participationBracketSelect;
}>;

interface ParticipationSnapshot {
  readonly profile: ParticipationProfile;
  readonly bracket: ParticipationBracket;
  readonly athleteGti: number;
}

export function assertCompleteVerifiedProfile(
  profile: ParticipationProfile | null,
): asserts profile is ParticipationProfile {
  if (!profile)
    throw new BadRequestException(
      'Athlete profile must be initialized before tournament participation',
    );
  assertAccountAccess(profile.user);
  if (
    !profile.dateOfBirth ||
    !profile.gender ||
    !profile.primarySport ||
    !profile.district ||
    !profile.state
  ) {
    throw new BadRequestException('Complete the athlete passport before tournament participation');
  }
}

export function registrationIsOpen(tournament: ParticipationBracket['tournament']): boolean {
  return (
    tournament.status === TournamentStatus.REGISTRATION_OPEN &&
    Number.isFinite(tournament.registrationDeadline?.getTime()) &&
    tournament.registrationDeadline.getTime() >= Date.now()
  );
}

export async function readParticipationSnapshot(
  transaction: Prisma.TransactionClient,
  tournamentId: string,
  bracketId: string,
  userId: string,
): Promise<ParticipationSnapshot> {
  const profile = await transaction.athleteProfile.findUnique({
    where: { userId },
    select: participationProfileSelect,
  });
  assertCompleteVerifiedProfile(profile);
  const bracket = await transaction.bracket.findUnique({
    where: { id: bracketId },
    select: participationBracketSelect,
  });
  if (!bracket || bracket.tournamentId !== tournamentId)
    throw new NotFoundException('Bracket does not exist in this tournament');
  if (!registrationIsOpen(bracket.tournament))
    throw new BadRequestException('Tournament registration is closed or its deadline has passed');
  const athleteGti = Number(profile.currentGti);
  await assertScoreFitsBracket(transaction, bracket, athleteGti);
  return { profile, bracket, athleteGti };
}

export async function assertScoreFitsBracket(
  transaction: Prisma.TransactionClient,
  bracket: ParticipationBracket,
  score: number,
  subject: 'Athlete' | 'Team' = 'Athlete',
): Promise<void> {
  const minGti = Number(bracket.minGti);
  const maxGti = Number(bracket.maxGti);
  if (!Number.isFinite(score)) throw new BadRequestException(`${subject} GTI is invalid`);
  if (score > maxGti) {
    const recommendations = await transaction.bracket.findMany({
      where: {
        tournamentId: bracket.tournamentId,
        id: { not: bracket.id },
        minGti: { lte: score },
        maxGti: { gte: score },
      },
      orderBy: [{ minGti: 'asc' }, { id: 'asc' }],
      take: 1,
      select: { id: true, tierName: true },
    });
    throw new ConflictException({
      code: 'SANDBAGGING_DETECTED',
      error: 'Conflict',
      message: `${subject} GTI exceeds this bracket's maximum`,
      athleteGti: score,
      ...(subject === 'Team' ? { teamGti: score } : {}),
      bracketMinGti: minGti,
      bracketMaxGti: maxGti,
      suggestedBracketId: recommendations[0]?.id ?? null,
      suggestedBracketTier: recommendations[0]?.tierName ?? null,
    });
  }
  if (score < minGti)
    throw new ConflictException({
      code: 'BELOW_MINIMUM_TIER',
      error: 'Conflict',
      message: `${subject} GTI is below this bracket's minimum`,
      athleteGti: score,
      bracketMinGti: minGti,
      bracketMaxGti: maxGti,
    });
}
