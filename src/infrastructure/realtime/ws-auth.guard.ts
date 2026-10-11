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
  private readonly algorithm: 'RS256' | 'HS256';

  constructor(private readonly configService: ConfigService) {
    const keyPath = this.configService.get<string>('auth.jwtPublicKeyPath', './keys/public.pem');
    const privateKeyPath = this.configService.get<string>(
      'auth.jwtPrivateKeyPath',
      './keys/private.pem',
    );
    const publicKeyExists = fs.existsSync(keyPath);
    const privateKeyExists = fs.existsSync(privateKeyPath);
    if (publicKeyExists !== privateKeyExists) {
      throw new Error('Both JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must exist.');
    }
    try {
      if (!publicKeyExists) {
        throw new Error('JWT public key is not configured.');
      }
      const publicKey = fs.readFileSync(keyPath, 'utf-8');
      this.publicKey = publicKey;
      this.algorithm = 'RS256';
    } catch {
      const symmetricSecret = this.configService.get<string>('auth.identityPepper');
      const isProduction =
        this.configService.get<string>('app.nodeEnv', 'development') === 'production';
      if (!symmetricSecret && isProduction) {
        throw new Error('JWT public key or IDENTITY_PEPPER must be configured in production.');
      }
      this.publicKey = symmetricSecret ?? 'local-development-jwt-secret';
      this.algorithm = 'HS256';
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
        algorithms: [this.algorithm],
      }) as JwtPayload;

      (client as Socket & { user: JwtPayload }).user = payload;
      return true;
    } catch {
      throw new WsException('Invalid or expired token');
    }
  }
}
