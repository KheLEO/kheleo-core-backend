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
    this.secret = this.configService.get<string>('auth.drillHmacSecret', '');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const signature = request.headers['x-device-signature'] as string | undefined;

    if (!signature) {
      throw new ForbiddenException('Missing X-Device-Signature header');
    }

    const bodyStr =
      typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body);

    const expectedHmac = crypto
      .createHmac('sha256', this.secret)
      .update(bodyStr)
      .digest('hex');

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
}
