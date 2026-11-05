import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export function competitionConfig(
  input: unknown,
  teamSize: number,
  prizePool: number,
): Prisma.InputJsonObject {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('Competition configuration must be an object');
  const config = input as Record<string, unknown>;
  const quotas = config.roleQuotas;
  if (quotas !== undefined) {
    if (!quotas || typeof quotas !== 'object' || Array.isArray(quotas))
      throw new BadRequestException('roleQuotas must be an object');
    const entries = Object.entries(quotas);
    if (
      !entries.length ||
      entries.length > 30 ||
      entries.some(
        ([role, count]) =>
          !/^[A-Z][A-Z0-9_]{1,39}$/.test(role) ||
          typeof count !== 'number' ||
          !Number.isInteger(count) ||
          count < 0 ||
          count > 30,
      )
    )
      throw new BadRequestException(
        'Role quotas require canonical role names and integer counts between 0 and 30',
      );
    if (entries.reduce((total, [, count]) => total + Number(count), 0) !== teamSize)
      throw new BadRequestException('Role quota total must equal tournament teamSize');
  }
  if (config.prizeBreakdown !== undefined) {
    const prizes = config.prizeBreakdown;
    if (!prizes || typeof prizes !== 'object' || Array.isArray(prizes))
      throw new BadRequestException('prizeBreakdown must contain first, second and third');
    const values = prizes as Record<string, unknown>;
    if (
      Object.keys(values).some((key) => !['first', 'second', 'third'].includes(key)) ||
      ['first', 'second', 'third'].some(
        (key) =>
          typeof values[key] !== 'number' ||
          !Number.isFinite(values[key]) ||
          Number(values[key]) < 0,
      )
    )
      throw new BadRequestException('Prize values must be nonnegative finite numbers');
    if (Number(values.first) + Number(values.second) + Number(values.third) > prizePool)
      throw new BadRequestException('Prize breakdown exceeds the tournament prize pool');
  }
  return config as Prisma.InputJsonObject;
}
