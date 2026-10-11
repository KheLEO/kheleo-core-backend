import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyRequest } from 'fastify';
import * as jwt from 'jsonwebtoken';
import * as fs from 'node:fs';

interface JwtPayload {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly publicKey: string;

  constructor(private readonly configService: ConfigService) {
    const keyPath = this.configService.get<string>(
      'auth.jwtPublicKeyPath',
      './keys/public.pem',
    );
    try {
      this.publicKey = fs.readFileSync(keyPath, 'utf-8');
    } catch {
      this.publicKey = this.configService.get<string>(
        'auth.identityPepper',
        'dev-secret-key',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const authHeader = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256', 'HS256'],
      }) as JwtPayload;

      (request as FastifyRequest & { user: JwtPayload }).user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}
