import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { assertAccountAccess } from '../../../common/auth/account-access';
import { AuthenticatedJwtUser } from '../../../common/guards/jwt-auth.guard';
import { loadLocalJwtKeys } from '../jwt-keys';

export interface JwtTokenPayload extends AuthenticatedJwtUser {
  readonly exp: number;
  readonly iat?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const local = loadLocalJwtKeys(configService);
    const supabaseSecret = configService.get<string>('auth.supabaseJwtSecret');
    const hmacSecrets = [
      ...(local.algorithm === 'HS256' ? [local.verificationKey] : []),
      ...(supabaseSecret ? [supabaseSecret] : []),
    ];
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: [
        ...(local.algorithm === 'RS256' ? ['RS256' as const] : []),
        ...(hmacSecrets.length ? ['HS256' as const] : []),
      ],
      secretOrKeyProvider: (
        _request: unknown,
        token: string,
        done: (error: Error | null, key?: string) => void,
      ): void => {
        const decoded = jwt.decode(token, { complete: true });
        if (decoded?.header.alg === 'RS256' && local.algorithm === 'RS256') {
          done(null, local.verificationKey);
          return;
        }
        if (decoded?.header.alg === 'HS256') {
          for (const secret of hmacSecrets) {
            try {
              jwt.verify(token, secret, { algorithms: ['HS256'] });
              done(null, secret);
              return;
            } catch {
              // Try the other explicitly configured HMAC authority.
            }
          }
        }
        done(new UnauthorizedException('Invalid or expired authentication token'));
      },
    });
  }

  async validate(payload: unknown): Promise<JwtTokenPayload> {
    if (
      !isRecord(payload) ||
      typeof payload.sub !== 'string' ||
      !isUUID(payload.sub) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= Date.now() / 1000
    ) {
      throw new UnauthorizedException('Invalid or expired token payload');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        isActive: true,
        email: true,
        phone: true,
        identityRecord: { select: { status: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Account does not exist');
    assertAccountAccess(user);
    const metadataRole = isRecord(payload.user_metadata) ? payload.user_metadata.role : undefined;
    const claimedRole = payload.role === 'authenticated' ? metadataRole : payload.role;
    return {
      sub: user.id,
      // Supabase user_metadata is user editable; stored roles remain authoritative.
      role: typeof claimedRole === 'string' && claimedRole === user.role ? claimedRole : user.role,
      ...(typeof payload.email === 'string'
        ? { email: payload.email }
        : user.email
          ? { email: user.email }
          : {}),
      ...(typeof payload.phone === 'string'
        ? { phone: payload.phone }
        : user.phone
          ? { phone: user.phone }
          : {}),
      exp: payload.exp,
      ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
    };
  }
}
