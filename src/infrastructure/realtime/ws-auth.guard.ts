import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import * as fs from 'node:fs';
import { Socket } from 'socket.io';

interface JwtPayload {
  sub: string;
  role: string;
}

@Injectable()
export class WsAuthGuard implements CanActivate {
  private readonly publicKey: string;

  constructor(private readonly configService: ConfigService) {
    const keyPath = this.configService.get<string>(
      'auth.jwtPublicKeyPath',
      './keys/public.pem',
    );
    try {
      this.publicKey = fs.readFileSync(keyPath, 'utf-8');
    } catch {
      // Fallback for dev: use a symmetric secret
      this.publicKey = 'dev-secret-key';
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<Socket>();
    const token =
      client.handshake.auth?.['token'] ??
      client.handshake.headers?.['authorization']?.replace('Bearer ', '');

    if (!token) {
      throw new WsException('Missing authentication token');
    }

    try {
      const payload = jwt.verify(token, this.publicKey, {
        algorithms: ['RS256', 'HS256'],
      }) as JwtPayload;

      (client as Socket & { user: JwtPayload }).user = payload;
      return true;
    } catch {
      throw new WsException('Invalid or expired token');
    }
  }
}
