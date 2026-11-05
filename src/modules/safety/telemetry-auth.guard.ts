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
      const body = request.body as { athlete_id?: unknown; source?: unknown } | undefined;
      if (body?.athlete_id !== request.user.sub)
        throw new ForbiddenException('Telemetry athlete_id must match the authenticated athlete');
      if (body.source !== undefined) {
        this.hmac.canActivate(context);
        if (body.source !== 'BLE' && body.source !== 'SIMULATOR')
          throw new ForbiddenException('Unknown telemetry source');
        request.telemetrySource = body.source;
      } else request.telemetrySource = TelemetrySource.ATHLETE_JWT;
    } else {
      this.hmac.canActivate(context);
      const body = request.body as { source?: unknown } | undefined;
      if (body?.source !== undefined)
        throw new ForbiddenException(
          'Labeled browser telemetry also requires athlete authentication',
        );
      request.telemetrySource = TelemetrySource.DEVICE_HMAC;
    }
    return true;
  }
}
