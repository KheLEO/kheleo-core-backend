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

export interface AutonomousMatchPausePayload {
  readonly event: 'MATCH_PAUSE_ALERT';
  readonly severity: 'CRITICAL';
  readonly athlete_id: string;
  readonly athlete_name: string;
  readonly vitals: {
    readonly heart_rate: number;
    readonly spo2: number;
    readonly skin_temperature: number;
  };
  readonly directive: string;
  readonly tournament_id?: string;
  readonly bracket_id?: string;
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

  @SubscribeMessage('join:tournament')
  handleJoinTournament(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tournamentId: string },
  ): void {
    const room = `tournament:${data.tournamentId}`;
    void client.join(room);
    this.logger.debug(`${client.id} joined room ${room}`);
  }

  // ─── Server-side Broadcast Methods ──────────────────

  broadcastAutonomousMatchPause(payload: AutonomousMatchPausePayload): void {
    if (!this.server) {
      this.logger.warn('Socket server not ready during broadcastAutonomousMatchPause');
      return;
    }

    if (payload.tournament_id) {
      this.server
        .to(`tournament:${payload.tournament_id}`)
        .emit('MATCH_PAUSE_ALERT', payload);
      this.server
        .to(`organizer:${payload.tournament_id}`)
        .emit('MATCH_PAUSE_ALERT', payload);
      this.server
        .to(`umpire:${payload.tournament_id}`)
        .emit('MATCH_PAUSE_ALERT', payload);
    }

    if (payload.bracket_id) {
      this.server
        .to(`bracket:${payload.bracket_id}`)
        .emit('MATCH_PAUSE_ALERT', payload);
    }

    // Broadcast across umpire and organizer rooms
    this.server.to('umpires').emit('MATCH_PAUSE_ALERT', payload);
    this.server.to('organizers').emit('MATCH_PAUSE_ALERT', payload);

    // Also global broadcast
    this.server.emit('MATCH_PAUSE_ALERT', payload);

    this.logger.warn(
      `CRITICAL MATCH_PAUSE_ALERT autonomously broadcast for athlete ${payload.athlete_id}`,
    );
  }

  broadcastMatchPause(payload: MatchPauseAlertPayload): void {
    if (!this.server) return;
    this.server
      .to(`match:${payload.matchId}`)
      .emit('MATCH_PAUSE_ALERT', payload);
    this.logger.warn(`MATCH_PAUSE_ALERT dispatched for match ${payload.matchId}`);
  }

  broadcastFreeAgentMatched(payload: FreeAgentMatchedPayload): void {
    if (!this.server) return;
    this.server
      .to(`athlete:${payload.athleteId}`)
      .emit('FREE_AGENT_MATCHED', payload);
  }

  broadcastGtiUpdated(payload: GtiUpdatedPayload): void {
    if (!this.server) return;
    this.server
      .to(`athlete:${payload.athleteId}`)
      .emit('GTI_UPDATED', payload);
  }
}
