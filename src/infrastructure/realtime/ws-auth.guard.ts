import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { JwtStrategy, JwtTokenPayload } from '../../modules/auth/strategies/jwt.strategy';

type SocketEvents = Record<string, (...args: unknown[]) => void>;
export interface SocketData {
  user?: JwtTokenPayload;
}
export type AuthenticatedSocket = Socket<SocketEvents, SocketEvents, SocketEvents, SocketData>;
export type AuthenticatedNamespace = Namespace<
  SocketEvents,
  SocketEvents,
  SocketEvents,
  SocketData
>;

@Injectable()
export class WsAuthGuard implements CanActivate {
  private readonly namespaces = new Set<AuthenticatedNamespace>();
  constructor(private readonly jwtStrategy: JwtStrategy) {}

  async authenticate(client: AuthenticatedSocket): Promise<JwtTokenPayload> {
    const auth = client.handshake.auth as Readonly<Record<string, unknown>>;
    const query = client.handshake.query.token;
    const token =
      auth.token ?? client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') ?? query;
    if (typeof token !== 'string' || !token.trim())
      throw new WsException('Missing authentication token');
    const user = await this.jwtStrategy.authenticateToken(token);
    client.data.user = user;
    return user;
  }

  configure(server: AuthenticatedNamespace): void {
    this.namespaces.add(server);
    server.use((client, next) => {
      void this.authenticate(client).then(
        () => next(),
        () => next(new Error('Unauthorized connection')),
      );
    });
  }

  async accept(client: AuthenticatedSocket): Promise<void> {
    try {
      const user = await this.authenticate(client);
      await client.join([`user:${user.sub}`, `role:${user.role}`, `athlete:${user.sub}`]);
      if (['SCOUT', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(user.role))
        await client.join('scouts');
      const timer = setTimeout(
        () => client.disconnect(true),
        Math.max(0, user.exp * 1000 - Date.now()),
      );
      timer.unref();
      client.once('disconnect', () => clearTimeout(timer));
    } catch {
      client.disconnect(true);
    }
  }

  disconnectUser(userId: string): void {
    for (const namespace of this.namespaces) namespace.in(`user:${userId}`).disconnectSockets(true);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<AuthenticatedSocket>();
    try {
      await this.authenticate(client);
      return true;
    } catch {
      client.disconnect(true);
      throw new WsException('Invalid or expired token');
    }
  }
}
