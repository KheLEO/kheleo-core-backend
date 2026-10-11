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

@Injectable()
export class HmacTamperGuard implements CanActivate {
  private readonly logger = new Logger(HmacTamperGuard.name);
  private readonly secret: string;

  constructor(private readonly configService: ConfigService) {
    const configuredSecret = this.configService.get<string>('auth.telemetryHmacSecret');
    const isProduction =
      this.configService.get<string>('app.nodeEnv', 'development') === 'production';
    if (!configuredSecret && isProduction) {
      throw new Error('TELEMETRY_SERVICE_HMAC_SECRET must be configured in production.');
    }
    this.secret = configuredSecret ?? 'local-development-telemetry-secret';
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const signature = request.headers['x-device-signature'] as string | undefined;

    if (!signature || !/^[a-f\d]{64}$/i.test(signature)) {
      throw new ForbiddenException('Missing X-Device-Signature header');
    }

    const timestamp = this.readTimestamp(request.body);
    const timestampSeconds = timestamp > 1e11 ? timestamp / 1000 : timestamp;
    if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
      throw new ForbiddenException('Telemetry timestamp is outside the 300-second window');
    }

    const bodyStr = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);

    const expectedHmac = crypto.createHmac('sha256', this.secret).update(bodyStr).digest('hex');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedHmac, 'hex'),
    );

    if (!isValid) {
      this.logger.warn('Tampered device signature detected');
      throw new ForbiddenException('Invalid device signature — payload tampered');
    }

    return true;
  }

  private readTimestamp(body: unknown): number {
    if (typeof body !== 'object' || body === null || !('timestamp' in body)) {
      throw new ForbiddenException('Telemetry timestamp is required');
    }
    const rawTimestamp = (body as { timestamp?: unknown }).timestamp;
    const timestamp = Number(rawTimestamp);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      throw new ForbiddenException('Telemetry timestamp is invalid');
    }
    return timestamp;
  }
}
