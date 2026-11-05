import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { ForbiddenException, Logger, UseGuards } from '@nestjs/common';

import {
  AuthenticatedSocket,
  AuthenticatedNamespace,
  WsAuthGuard,
} from '../../infrastructure/realtime/ws-auth.guard';

import { RoomAccessService } from '../../infrastructure/realtime/room-access.service';

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
export class MatchmakingGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server!: AuthenticatedNamespace;

  private readonly logger = new Logger(MatchmakingGateway.name);

  constructor(
    private readonly auth: WsAuthGuard,
    private readonly access: RoomAccessService,
  ) {}
  afterInit(server: AuthenticatedNamespace): void {
    this.auth.configure(server);
  }
  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    await this.auth.accept(client);
  }

  @SubscribeMessage('join:user')
  handleJoinUser(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { userId: string },
  ): void {
    if (!client.data.user || client.data.user.sub !== data.userId) {
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
    if (!(await this.access.canJoin(client.data.user, 'bracket', data?.bracketId)))
      throw new ForbiddenException('Cannot subscribe to this bracket.');
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
      this.server
        .to(`bracket:${data.bracket_id}`)
        .to(data.roster.map((member) => `user:${member.user_id}`))
        .emit('ROSTER_FORMED', payload);
    }

    this.logger.log(
      `Dispatched ROSTER_FORMED for team ${data.team_name} (Bracket: ${data.bracket_id}, ${data.roster.length} members)`,
    );
  }
}
