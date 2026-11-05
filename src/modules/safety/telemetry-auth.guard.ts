import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { TelemetrySource, UserRole } from '@prisma/client';
import { FastifyRequest } from 'fastify';
import { HmacTamperGuard } from '../../common/guards/hmac-tamper.guard';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AuthenticatedJwtUser } from '../../common/guards/jwt-auth.guard';

export interface TelemetryRequest extends FastifyRequest {
  user?: AuthenticatedJwtUser;
  telemetrySource: TelemetrySource;
}
@Injectable()
export class TelemetryAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtStrategy,
    private readonly hmac: HmacTamperGuard,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TelemetryRequest>();
    const authorization = request.headers.authorization;
    if (authorization) {
      const match = /^Bearer\s+(.+)$/i.exec(authorization);
      if (!match) throw new ForbiddenException('Bearer authentication required');
      request.user = await this.jwt.authenticateToken(match[1]);
      if (request.user.role !== UserRole.ATHLETE)
        throw new ForbiddenException('Athlete telemetry only');
      const body = request.body as { athlete_id?: unknown } | undefined;
      if (body?.athlete_id !== request.user.sub)
        throw new ForbiddenException('Telemetry athlete_id must match the authenticated athlete');
      request.telemetrySource = TelemetrySource.ATHLETE_JWT;
    } else {
      this.hmac.canActivate(context);
      request.telemetrySource = TelemetrySource.DEVICE_HMAC;
    }
    return true;
  }
}
