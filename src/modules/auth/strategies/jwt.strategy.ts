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
  constructor(private readonly configService: ConfigService) {
    let secretOrKey = 'kheleo_prod_identity_pepper_secure_seed_2026';
    const keyPath = configService.get<string>(
      'auth.jwtPublicKeyPath',
      './keys/public.pem',
    );

    try {
      if (fs.existsSync(keyPath)) {
        secretOrKey = fs.readFileSync(keyPath, 'utf-8');
      }
    } catch {
      secretOrKey =
        configService.get<string>('auth.identityPepper') ||
        'kheleo_prod_identity_pepper_secure_seed_2026';
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey,
      algorithms: ['RS256', 'HS256'],
    });
  }

  async validate(payload: JwtTokenPayload): Promise<JwtTokenPayload> {
    if (!payload.sub || !payload.role) {
      throw new UnauthorizedException('Invalid token payload');
    }
    return payload;
  }
}
