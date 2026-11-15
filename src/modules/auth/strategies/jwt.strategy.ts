import { ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import * as jwt from 'jsonwebtoken';
import { UserRole, VerificationStatus } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma.service';
import { RedisService } from '../../../infrastructure/cache/redis.service';
import {
  CACHE_KEYS,
  invalidateAuthAndPassport,
  readThroughCache,
} from '../../../infrastructure/cache/cache-helper';
import { assertAccountAccess } from '../../../common/auth/account-access';
import { AuthenticatedJwtUser } from '../../../common/guards/jwt-auth.guard';
import { loadLocalJwtKeys } from '../jwt-keys';

interface CachedAuthUserRecord {
  readonly id: string;
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly email: string | null;
  readonly phone: string | null;
  readonly identityStatus: VerificationStatus | null;
}

export interface JwtTokenPayload extends AuthenticatedJwtUser {
  readonly exp: number;
  readonly iat?: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly verifyToken: (token: string) => unknown;
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
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
    this.verifyToken = (token: string): unknown => {
      const decoded = jwt.decode(token, { complete: true });
      if (decoded?.header.alg === 'RS256' && local.algorithm === 'RS256') {
        return jwt.verify(token, local.verificationKey, { algorithms: ['RS256'] });
      }
      if (decoded?.header.alg === 'HS256') {
        for (const secret of hmacSecrets) {
          try {
            return jwt.verify(token, secret, { algorithms: ['HS256'] });
          } catch {
            /* Try the next configured authority. */
          }
        }
      }
      throw new UnauthorizedException('Invalid or expired authentication token');
    };
  }

  async authenticateToken(token: string): Promise<JwtTokenPayload> {
    let payload: unknown;
    try {
      payload = this.verifyToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication token');
    }
    return this.validate(payload);
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
    let loadedFromDatabase = false;
    let cachedUser = await readThroughCache<CachedAuthUserRecord | null>(
      this.redis,
      CACHE_KEYS.authUser(payload.sub),
      120,
      async () => {
        loadedFromDatabase = true;
        const record = await this.prisma.user.findUnique({
          where: { id: payload.sub as string },
          select: {
            id: true,
            role: true,
            isActive: true,
            email: true,
            phone: true,
            identityRecord: { select: { status: true } },
          },
        });
        if (!record) return null;
        return {
          id: record.id,
          role: record.role,
          isActive: record.isActive,
          email: record.email,
          phone: record.phone,
          identityStatus: record.identityRecord?.status ?? null,
        };
      },
    );
    if (!loadedFromDatabase) {
      // Cached contact details are safe to reuse; access decisions must survive a missed Redis invalidation.
      const current = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          isActive: true,
          identityRecord: { select: { status: true } },
        },
      });
      if (!current) {
        await invalidateAuthAndPassport(this.redis, payload.sub);
        throw new UnauthorizedException('Account does not exist');
      }
      const identityStatus = current.identityRecord?.status ?? null;
      if (
        !cachedUser ||
        cachedUser.role !== current.role ||
        cachedUser.isActive !== current.isActive ||
        cachedUser.identityStatus !== identityStatus
      ) {
        await invalidateAuthAndPassport(this.redis, payload.sub);
      }
      cachedUser = {
        id: current.id,
        role: current.role,
        isActive: current.isActive,
        identityStatus,
        email: cachedUser?.email ?? null,
        phone: cachedUser?.phone ?? null,
      };
    }
    if (!cachedUser) throw new UnauthorizedException('Account does not exist');
    try {
      assertAccountAccess({
        isActive: cachedUser.isActive,
        identityRecord: cachedUser.identityStatus ? { status: cachedUser.identityStatus } : null,
      });
    } catch (error: unknown) {
      await invalidateAuthAndPassport(this.redis, payload.sub);
      throw error;
    }
    if (
      ['ORGANIZER', 'SCOUT'].includes(cachedUser.role) &&
      cachedUser.identityStatus !== 'VERIFIED'
    )
      throw new ForbiddenException('Administrator identity verification is pending');
    const metadataRole = isRecord(payload.user_metadata) ? payload.user_metadata.role : undefined;
    const claimedRole = payload.role === 'authenticated' ? metadataRole : payload.role;
    return {
      sub: cachedUser.id,
      identityVerified: cachedUser.identityStatus === 'VERIFIED',
      // Supabase user_metadata is user editable; stored roles remain authoritative.
      role:
        typeof claimedRole === 'string' && claimedRole === cachedUser.role
          ? claimedRole
          : cachedUser.role,
      ...(typeof payload.email === 'string'
        ? { email: payload.email }
        : cachedUser.email
          ? { email: cachedUser.email }
          : {}),
      ...(typeof payload.phone === 'string'
        ? { phone: payload.phone }
        : cachedUser.phone
          ? { phone: cachedUser.phone }
          : {}),
      exp: payload.exp,
      ...(typeof payload.iat === 'number' ? { iat: payload.iat } : {}),
    };
  }
}
