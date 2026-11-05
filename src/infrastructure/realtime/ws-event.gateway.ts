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
import { ForbiddenException, Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { WsAuthGuard } from './ws-auth.guard';
import { PrismaService } from '../database/prisma.service';

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
  readonly match_id?: string;
}

export interface GtiUpdatedPayload {
  readonly athleteId: string;
  readonly previousGti: number;
  readonly newGti: number;
  readonly eliteBreached: boolean;
}

interface AuthenticatedSocket extends Socket {
  readonly user?: { readonly sub: string; readonly role: string };
}

@WebSocketGateway({
  namespace: '/ws/events',
  cors: { origin: '*' },
})
@UseGuards(WsAuthGuard)
export class WsEventGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WsEventGateway.name);

  constructor(private readonly prisma: PrismaService) {}

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
  async handleJoinMatch(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { matchId: string },
  ): Promise<void> {
    if (!(await this.canJoinMatchRoom(client, data.matchId))) {
      throw new ForbiddenException('Only competition staff may subscribe to match events.');
    }
    const room = `match:${data.matchId}`;
    void client.join(room);
    this.logger.debug(`${client.id} joined room ${room}`);
  }

  @SubscribeMessage('join:athlete')
  handleJoinAthlete(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { athleteId: string },
  ): void {
    const privilegedRoles = new Set(['SCOUT', 'ORGANIZER', 'FEDERATION_ADMIN', 'SUPER_ADMIN']);
    if (
      !client.user ||
      (client.user.sub !== data.athleteId && !privilegedRoles.has(client.user.role))
    ) {
      return;
    }
    const room = `athlete:${data.athleteId}`;
    void client.join(room);
    this.logger.debug(`${client.id} joined room ${room}`);
  }

  @SubscribeMessage('join:tournament')
  async handleJoinTournament(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { tournamentId: string },
  ): Promise<void> {
    if (!(await this.canJoinTournamentRoom(client, data.tournamentId))) {
      throw new ForbiddenException('Only competition staff may subscribe to tournament events.');
    }
    const room = `tournament:${data.tournamentId}`;
    void client.join(room);
    this.logger.debug(`${client.id} joined room ${room}`);
  }

  private async canJoinTournamentRoom(
    client: AuthenticatedSocket,
    tournamentId: string,
  ): Promise<boolean> {
    const user = client.user;
    if (!user) return false;
    if (user.role === 'FEDERATION_ADMIN' || user.role === 'SUPER_ADMIN') return true;
    if (user.role !== 'ORGANIZER') return false;
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { organizerId: true },
    });
    return tournament?.organizerId === user.sub;
  }

  private async canJoinMatchRoom(
    client: AuthenticatedSocket,
    matchId: string,
  ): Promise<boolean> {
    const user = client.user;
    if (!user) return false;
    if (user.role === 'FEDERATION_ADMIN' || user.role === 'SUPER_ADMIN') return true;
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: {
        umpireId: true,
        bracket: { select: { tournament: { select: { organizerId: true } } } },
      },
    });
    if (!match) return false;
    return (
      (user.role === 'ORGANIZER' && match.bracket.tournament.organizerId === user.sub) ||
      (user.role === 'UMPIRE' && match.umpireId === user.sub)
    );
  }

  // ─── Server-side Broadcast Methods ──────────────────

  broadcastAutonomousMatchPause(payload: AutonomousMatchPausePayload): void {
    if (!this.server) {
      this.logger.warn('Socket server not ready during broadcastAutonomousMatchPause');
      return;
    }

    if (payload.tournament_id) {
      this.server.to(`tournament:${payload.tournament_id}`).emit('MATCH_PAUSE_ALERT', payload);
      this.server.to(`organizer:${payload.tournament_id}`).emit('MATCH_PAUSE_ALERT', payload);
      this.server.to(`umpire:${payload.tournament_id}`).emit('MATCH_PAUSE_ALERT', payload);
    }

    if (payload.bracket_id) {
      this.server.to(`bracket:${payload.bracket_id}`).emit('MATCH_PAUSE_ALERT', payload);
    }

    if (payload.match_id) {
      this.server.to(`match:${payload.match_id}`).emit('MATCH_PAUSE_ALERT', payload);
    }

    this.logger.warn(
      `CRITICAL MATCH_PAUSE_ALERT autonomously broadcast for athlete ${payload.athlete_id}`,
    );
  }

  broadcastGtiUpdated(payload: GtiUpdatedPayload): void {
    if (!this.server) return;
    this.server.to(`athlete:${payload.athleteId}`).emit('GTI_UPDATED', payload);
  }
}
