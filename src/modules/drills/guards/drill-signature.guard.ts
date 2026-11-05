import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DrillSignatureVersion, SportType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SubmitDrillDto } from '../dto/submit-drill.dto';
import { AuthenticatedJwtUser } from '../../../common/guards/jwt-auth.guard';
import { canonicalJson } from '../../../common/crypto/canonical-json';

export interface DrillRequest extends FastifyRequest {
  readonly user?: AuthenticatedJwtUser;
  drillSignatureVersion?: DrillSignatureVersion;
}

export function fullDrillPayload(
  athleteId: string,
  dto: SubmitDrillDto,
  timestamp = dto.timestamp,
): string {
  return `${athleteId}:${dto.sport}:${dto.drill_type}:${dto.form_score}:${dto.frames_analyzed}:${JSON.stringify(dto.flaw_flags ?? [])}:${timestamp}`;
}

export function canonicalDrillPayload(athleteId: string, dto: SubmitDrillDto): string {
  return canonicalJson({
    athlete_id: athleteId,
    sport: dto.sport,
    drill_type: dto.drill_type,
    form_score: dto.form_score,
    frames_analyzed: dto.frames_analyzed,
    flaw_flags: dto.flaw_flags ?? [],
    joint_angles_summary: dto.joint_angles_summary ?? {},
    timestamp: dto.timestamp,
  });
}

@Injectable()
export class DrillSignatureGuard implements CanActivate {
  private readonly secret: string;
  constructor(config: ConfigService) {
    const secret = config.get<string>('auth.drillHmacSecret');
    if (!secret && config.get<string>('app.nodeEnv', 'development') === 'production')
      throw new Error('DRILL_HMAC_SECRET must be configured in production.');
    this.secret = secret || 'local-development-drill-secret';
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<DrillRequest>();
    const raw = request.headers['x-drill-signature'];
    const signature = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
    if (!signature || !/^[a-f\d]{64}$/.test(signature))
      throw new ForbiddenException('Missing or invalid x-drill-signature header');
    request.headers['x-drill-signature'] = signature;
    if (!request.user) throw new ForbiddenException('Authenticated athlete identity is required');
    if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body))
      throw new ForbiddenException('Malformed drill payload');
    const dto = plainToInstance(SubmitDrillDto, request.body);
    if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
      throw new ForbiddenException('Malformed drill payload');
    const athleteId = dto.athlete_id ?? request.user.sub;
    if (athleteId !== request.user.sub)
      throw new ForbiddenException('Drill athlete_id must match the authenticated user');
    const seconds =
      dto.timestamp > 1e11 ? Math.floor(dto.timestamp / 1000) : Math.floor(dto.timestamp);
    if (Math.abs(Date.now() / 1000 - seconds) > 300)
      throw new ForbiddenException('Drill timestamp expired (anti-replay check failed)');
    if (dto.frames_analyzed > 18000)
      throw new ForbiddenException('Drill frames_analyzed exceeds the supported 18000-frame limit');
    const drill = dto.drill_type.toUpperCase();
    const coherence: ReadonlyArray<readonly [RegExp, SportType]> = [
      [/BOWL|BATT|WICKET/, SportType.CRICKET],
      [/SMASH|DROP/, SportType.BADMINTON],
      [/STRIKE|DRIBBLE/, SportType.FOOTBALL],
      ...Object.values(SportType).map((sport): readonly [RegExp, SportType] => [
        new RegExp(sport),
        sport,
      ]),
    ];
    if (coherence.some(([pattern, sport]) => pattern.test(drill) && sport !== dto.sport))
      throw new ForbiddenException('Drill type does not match the declared sport');
    const matches = (payload: string): boolean =>
      timingSafeEqual(
        Buffer.from(signature, 'hex'),
        createHmac('sha256', this.secret).update(payload).digest(),
      );
    const rawHint = request.headers['x-drill-signed-fields'];
    const hint = (Array.isArray(rawHint) ? rawHint[0] : rawHint)?.trim().toLowerCase();
    if (hint !== undefined && !['full', 'full-v2'].includes(hint))
      throw new ForbiddenException('Unsupported drill signing protocol');
    if (matches(canonicalDrillPayload(athleteId, dto)))
      request.drillSignatureVersion = DrillSignatureVersion.FULL_V2;
    else if (
      hint !== 'full-v2' &&
      Object.keys(dto.joint_angles_summary ?? {}).length === 0 &&
      [dto.timestamp, seconds].some((time) => matches(fullDrillPayload(athleteId, dto, time)))
    )
      request.drillSignatureVersion = DrillSignatureVersion.FULL;
    else {
      const signed = request.headers['x-drill-signed-fields'];
      if (
        signed !== undefined ||
        ![dto.timestamp, seconds].some((time) =>
          matches(`${athleteId}:${dto.drill_type}:${dto.form_score}:${time}`),
        )
      )
        throw new ForbiddenException('Invalid drill cryptographic signature — payload tampered');
      request.drillSignatureVersion = DrillSignatureVersion.LEGACY;
    }
    return true;
  }
}
