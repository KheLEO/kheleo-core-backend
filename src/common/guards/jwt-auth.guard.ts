import { Injectable, ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export interface AuthenticatedJwtUser {
  readonly sub: string;
  readonly role: string;
  readonly identityVerified?: boolean;
  readonly email?: string;
  readonly phone?: string;
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = AuthenticatedJwtUser>(
    err: unknown,
    user: TUser,
    _info: unknown,
    _context: ExecutionContext,
  ): TUser {
    if (err || !user) {
      if (err instanceof HttpException) throw err;
      if (err instanceof Error) {
        throw new UnauthorizedException(err.message);
      }
      throw new UnauthorizedException('Missing, invalid, or expired authentication token');
    }
    return user;
  }
}
