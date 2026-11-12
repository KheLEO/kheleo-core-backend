import { CanActivate, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { JwtStrategy, JwtTokenPayload } from '../../modules/auth/strategies/jwt.strategy';
import { RedisWsBridge } from './redis-ws-bridge.service';

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
  constructor(
    private readonly jwtStrategy: JwtStrategy,
    @Optional() private readonly wsBridge?: RedisWsBridge,
  ) {
    this.wsBridge?.registerDisconnectHandler((userId) => this.disconnectLocalUser(userId));
  }

  async authenticate(client: AuthenticatedSocket): Promise<JwtTokenPayload> {
    const auth = client.handshake.auth as Readonly<Record<string, unknown>>;
    const query = client.handshake.query.token;
    const candidate =
      auth.token ?? client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '') ?? query;
    if (typeof candidate !== 'string' || !candidate.trim())
      throw new WsException('Missing authentication token');
    const token = candidate.replace(/^Bearer\s+/i, '').trim();
    const user = await this.jwtStrategy.authenticateToken(token);
    client.data.user = user;
    return user;
  }

  configure(server: AuthenticatedNamespace): void {
    this.namespaces.add(server);
    server.use((client, next) => {
      void this.authenticate(client).then(
        async (user) => {
          await client.join([`user:${user.sub}`, `athlete:${user.sub}`]);
          if (user.identityVerified !== false || !['ORGANIZER', 'SCOUT'].includes(user.role))
            await client.join(`role:${user.role}`);
          if (
            ['SCOUT', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(user.role) &&
            (user.role !== 'SCOUT' || user.identityVerified !== false)
          )
            await client.join('scouts');
          next();
        },
        () => next(new Error('Unauthorized connection')),
      );
    });
  }

  async accept(client: AuthenticatedSocket): Promise<void> {
    try {
      const cached = client.data.user;
      const hasValidSession = cached && cached.exp * 1000 > Date.now();
      const user = hasValidSession ? cached : await this.authenticate(client);
      if (!hasValidSession) {
        await client.join([`user:${user.sub}`, `athlete:${user.sub}`]);
        if (user.identityVerified !== false || !['ORGANIZER', 'SCOUT'].includes(user.role))
          await client.join(`role:${user.role}`);
        if (
          ['SCOUT', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(user.role) &&
          (user.role !== 'SCOUT' || user.identityVerified !== false)
        )
          await client.join('scouts');
      }
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

  disconnectLocalUser(userId: string): void {
    for (const namespace of this.namespaces) namespace.in(`user:${userId}`).disconnectSockets(true);
  }

  disconnectUser(userId: string): void {
    if (this.namespaces.size > 0) {
      this.disconnectLocalUser(userId);
    }
    this.wsBridge?.publishDisconnect(userId);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<AuthenticatedSocket>();
    try {
      const existing = client.data.user;
      if (existing && existing.exp * 1000 > Date.now()) {
        return true;
      }
      await this.authenticate(client);
      return true;
    } catch {
      client.disconnect(true);
      throw new WsException('Invalid or expired token');
    }
  }
}
