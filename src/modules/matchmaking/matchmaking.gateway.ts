import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

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
export class MatchmakingGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(MatchmakingGateway.name);

  afterInit(): void {
    this.logger.log('Matchmaking WebSocket Gateway initialized');
  }

  @SubscribeMessage('join:user')
  handleJoinUser(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId: string },
  ): void {
    const room = `user:${data.userId}`;
    void client.join(room);
    this.logger.debug(`Socket ${client.id} joined user room ${room}`);
  }

  @SubscribeMessage('join:bracket')
  handleJoinBracket(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { bracketId: string },
  ): void {
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

    // Broadcast to bracket room
    if (this.server) {
      this.server.to(`bracket:${data.bracket_id}`).emit('ROSTER_FORMED', payload);

      // Also deliver directly to each matched user's personal room
      for (const member of data.roster) {
        this.server.to(`user:${member.user_id}`).emit('ROSTER_FORMED', payload);
      }
    }

    this.logger.log(
      `Dispatched ROSTER_FORMED for team ${data.team_name} (Bracket: ${data.bracket_id}, ${data.roster.length} members)`,
    );
  }
}
