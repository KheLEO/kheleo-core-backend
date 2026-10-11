import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';

export interface JwtTokenPayload {
  readonly sub: string;
  readonly role: string;
  readonly email?: string;
  readonly phone?: string;
  readonly iat?: number;
  readonly exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    let secretOrKey = '';
    let algorithm: 'RS256' | 'HS256' = 'HS256';
    const keyPath = configService.get<string>('auth.jwtPublicKeyPath', './keys/public.pem');
    const privateKeyPath = configService.get<string>(
      'auth.jwtPrivateKeyPath',
      './keys/private.pem',
    );
    const publicKeyExists = fs.existsSync(keyPath);
    const privateKeyExists = fs.existsSync(privateKeyPath);
    if (publicKeyExists !== privateKeyExists) {
      throw new Error('Both JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must exist.');
    }

    try {
      if (publicKeyExists) {
        secretOrKey = fs.readFileSync(keyPath, 'utf-8');
        algorithm = 'RS256';
      }
    } catch {
      secretOrKey = '';
    }

    if (!secretOrKey) {
      const symmetricSecret = configService.get<string>('auth.identityPepper');
      const isProduction = configService.get<string>('app.nodeEnv', 'development') === 'production';
      if (!symmetricSecret && isProduction) {
        throw new Error('JWT public key or IDENTITY_PEPPER must be configured in production.');
      }
      secretOrKey = symmetricSecret ?? 'local-development-jwt-secret';
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey,
      algorithms: [algorithm],
    });
  }

  async validate(payload: JwtTokenPayload): Promise<JwtTokenPayload> {
    if (!payload.sub || !payload.role) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return payload;
  }
}
