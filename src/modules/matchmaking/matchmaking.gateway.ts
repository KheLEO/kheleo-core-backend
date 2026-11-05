import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { ForbiddenException, Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthGuard } from '../../infrastructure/realtime/ws-auth.guard';
import { PrismaService } from '../../infrastructure/database/prisma.service';

interface AuthenticatedSocket extends Socket {
  readonly user?: { readonly sub: string; readonly role: string };
}

export interface RosterMemberPayload {
  readonly user_id: string;
  readonly name: string;
  readonly assigned_role: string;
  readonly gti: number;
}

export interface RosterFormedEventData {
  readonly team_id: string;
  readonly team_name: string;
  readonly bracket_id: string;
  readonly roster: readonly RosterMemberPayload[];
}

@WebSocketGateway({
  namespace: '/ws/matchmaking',
  cors: { origin: '*' },
})
@UseGuards(WsAuthGuard)
export class MatchmakingGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MatchmakingGateway.name);

  constructor(private readonly prisma: PrismaService) {}

  afterInit(): void {
    this.logger.log('Matchmaking WebSocket Gateway initialized');
  }

  @SubscribeMessage('join:user')
  handleJoinUser(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { userId: string },
  ): void {
    if (!client.user || client.user.sub !== data.userId) {
      throw new ForbiddenException("Cannot subscribe to another user's room.");
    }
    const room = `user:${data.userId}`;
    void client.join(room);
    this.logger.debug(`Socket ${client.id} joined user room ${room}`);
  }

  @SubscribeMessage('join:bracket')
  async handleJoinBracket(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { bracketId: string },
  ): Promise<void> {
    const user = client.user;
    if (!user || user.role === 'ATHLETE' || user.role === 'SCOUT') {
      throw new ForbiddenException('Only competition staff may subscribe to bracket events.');
    }
    if (user.role !== 'FEDERATION_ADMIN' && user.role !== 'SUPER_ADMIN') {
      const bracket = await this.prisma.bracket.findUnique({
        where: { id: data.bracketId },
        select: { tournament: { select: { organizerId: true } } },
      });
      if (!bracket || bracket.tournament.organizerId !== user.sub) {
        throw new ForbiddenException('You cannot subscribe to this bracket.');
      }
    }
    const room = `bracket:${data.bracketId}`;
    void client.join(room);
    this.logger.debug(`Socket ${client.id} joined bracket room ${room}`);
  }

  /**
   * Broadcasts the ROSTER_FORMED event targeting all matched members and the bracket room.
   */
  emitRosterFormed(data: RosterFormedEventData): void {
    const payload = {
      event: 'ROSTER_FORMED',
      data,
    };

    if (this.server) {
    this.server.to(`bracket:${data.bracket_id}`).emit('ROSTER_FORMED', payload);
    for (const member of data.roster) {
      this.server.to(`user:${member.user_id}`).emit('ROSTER_FORMED', payload);
    }
    }

    this.logger.log(
      `Dispatched ROSTER_FORMED for team ${data.team_name} (Bracket: ${data.bracket_id}, ${data.roster.length} members)`,
    );
  }
}
