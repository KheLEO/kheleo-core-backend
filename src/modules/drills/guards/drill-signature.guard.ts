import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import * as crypto from 'node:crypto';
import { SubmitDrillDto } from '../dto/submit-drill.dto';

@Injectable()
export class DrillSignatureGuard implements CanActivate {
  private readonly logger = new Logger(DrillSignatureGuard.name);
  private readonly secret: string;

  constructor(private readonly configService: ConfigService) {
    this.secret =
      this.configService.get<string>('auth.drillHmacSecret') ||
      process.env.DRILL_HMAC_SECRET ||
      'kheleo-drill-hmac-shared-secret';
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const headers = request.headers;
    const signature = (headers['x-drill-signature'] ||
      headers['x-device-signature']) as string | undefined;

    if (!signature) {
      throw new ForbiddenException('Missing x-drill-signature header');
    }

    const body = (request.body || {}) as SubmitDrillDto & { athleteId?: string };
    const user = (request as FastifyRequest & { user?: { sub: string } }).user;
    const athleteId = body.athlete_id || body.athleteId || user?.sub || '';
    const drillType = body.drill_type || '';
    const formScore = body.form_score ?? 0;
    const clientTimestamp = Number(body.timestamp || headers['x-timestamp'] || 0);

    if (!clientTimestamp) {
      throw new ForbiddenException('Client timestamp is required for replay prevention');
    }

    // Normalize timestamp to seconds
    const clientTimestampSec =
      clientTimestamp > 1e11
        ? Math.floor(clientTimestamp / 1000)
        : Math.floor(clientTimestamp);
    const nowSec = Math.floor(Date.now() / 1000);

    if (Math.abs(nowSec - clientTimestampSec) > 300) {
      this.logger.warn(
        `Replay attack prevented: client timestamp ${clientTimestampSec} deviates by > 300s from server time ${nowSec}`,
      );
      throw new ForbiddenException(
        'Drill submission timestamp expired or invalid (anti-replay check failed)',
      );
    }

    // Verify HMAC: check both standard delimited and continuous concatenations
    const payloadCandidates = [
      `${athleteId}:${drillType}:${formScore}:${clientTimestamp}`,
      `${athleteId}${drillType}${formScore}${clientTimestamp}`,
      `${athleteId}:${drillType}:${formScore}:${clientTimestampSec}`,
      `${athleteId}${drillType}${formScore}${clientTimestampSec}`,
    ];

    const isMatch = payloadCandidates.some((candidate) => {
      const expectedHmac = crypto
        .createHmac('sha256', this.secret)
        .update(candidate)
        .digest('hex');

      try {
        return (
          signature.length === expectedHmac.length &&
          crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedHmac, 'hex'),
          )
        );
      } catch {
        return false;
      }
    });

    if (!isMatch) {
      this.logger.warn(`Tampered drill signature detected for athlete ${athleteId}`);
      throw new ForbiddenException('Invalid drill cryptographic signature — payload tampered');
    }

    return true;
  }
}
