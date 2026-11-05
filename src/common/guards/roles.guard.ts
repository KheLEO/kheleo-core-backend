import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedJwtUser } from './jwt-auth.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const user = request['user'] as AuthenticatedJwtUser | undefined;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(`Access denied. Required role(s): ${requiredRoles.join(', ')}`);
    }

    if (['ORGANIZER', 'SCOUT'].includes(user.role) && user.identityVerified === false)
      throw new ForbiddenException('Administrator identity verification is pending');
    return true;
  }
}
