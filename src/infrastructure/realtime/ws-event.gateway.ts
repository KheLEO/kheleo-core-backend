import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthGuard } from './ws-auth.guard';

export interface MatchPauseAlertPayload {
  readonly matchId: string;
  readonly athleteId: string;
  readonly severity: string;
  readonly reason: string;
  readonly timestamp: string;
}

export interface FreeAgentMatchedPayload {
  readonly athleteId: string;
  readonly tournamentId: string;
  readonly teamName: string;
  readonly assignedRole: string;
}

export interface GtiUpdatedPayload {
  readonly athleteId: string;
  readonly previousGti: number;
  readonly newGti: number;
  readonly eliteBreached: boolean;
}

@WebSocketGateway({
  namespace: '/ws/events',
  cors: { origin: '*' },
})
@UseGuards(WsAuthGuard)
export class WsEventGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WsEventGateway.name);

  afterInit(): void {
    this.logger.log('WebSocket Gateway initialized');
  }

  handleConnection(client: Socket): void {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join:match')
  handleJoinMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ): void {
    const room = `match:${data.matchId}`;
    void client.join(room);
    this.logger.debug(`${client.id} joined room ${room}`);
  }

  @SubscribeMessage('join:athlete')
  handleJoinAthlete(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { athleteId: string },
  ): void {
    const room = `athlete:${data.athleteId}`;
    void client.join(room);
    this.logger.debug(`${client.id} joined room ${room}`);
  }

  // ─── Server-side Broadcast Methods ──────────────────

  broadcastMatchPause(payload: MatchPauseAlertPayload): void {
    this.server
      .to(`match:${payload.matchId}`)
      .emit('MATCH_PAUSE_ALERT', payload);
    this.logger.warn(`MATCH_PAUSE_ALERT dispatched for match ${payload.matchId}`);
  }

  broadcastFreeAgentMatched(payload: FreeAgentMatchedPayload): void {
    this.server
      .to(`athlete:${payload.athleteId}`)
      .emit('FREE_AGENT_MATCHED', payload);
  }

  broadcastGtiUpdated(payload: GtiUpdatedPayload): void {
    this.server
      .to(`athlete:${payload.athleteId}`)
      .emit('GTI_UPDATED', payload);
  }
}
