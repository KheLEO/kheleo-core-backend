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
import { ForbiddenException, Logger, Optional, UseGuards } from '@nestjs/common';

import { WsAuthGuard, AuthenticatedSocket, AuthenticatedNamespace } from './ws-auth.guard';
import { RoomAccessService } from './room-access.service';
import { ScoutAlertPayload } from '../queues/queue-producer.service';
import { RedisWsBridge } from './redis-ws-bridge.service';

export interface AutonomousMatchPausePayload {
  readonly event_id?: string;
  readonly alert_id?: string;
  readonly source?: string;
  readonly baseline_fields?: readonly string[];
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
  readonly eventId?: string;
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
export class WsEventGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: AuthenticatedNamespace;

  private readonly logger = new Logger(WsEventGateway.name);

  constructor(
    private readonly auth: WsAuthGuard,
    private readonly access: RoomAccessService,
    @Optional() private readonly wsBridge?: RedisWsBridge,
  ) {}

  afterInit(server: AuthenticatedNamespace): void {
    this.auth.configure(server);
    this.wsBridge?.registerNamespace('/ws/events', server as never);
  }
  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    await this.auth.accept(client);
  }
  handleDisconnect(): void {}

  @SubscribeMessage('join:match')
  async handleJoinMatch(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { matchId: string },
  ): Promise<void> {
    if (!(await this.access.canJoin(client.data.user, 'match', data?.matchId)))
      throw new ForbiddenException(
        'Only authorized competition staff may subscribe to match events',
      );
    await client.join(`match:${data.matchId}`);
    if (
      ['ORGANIZER', 'UMPIRE', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(
        client.data.user?.role ?? '',
      )
    )
      await client.join(`safety:match:${data.matchId}`);
  }

  @SubscribeMessage('join:athlete')
  async handleJoinAthlete(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { athleteId: string },
  ): Promise<void> {
    if (client.data.user?.sub === data?.athleteId) await client.join(`athlete:${data.athleteId}`);
  }

  @SubscribeMessage('join:tournament')
  async handleJoinTournament(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { tournamentId: string },
  ): Promise<{ joined: true }> {
    if (!(await this.access.canJoin(client.data.user, 'tournament', data?.tournamentId)))
      throw new ForbiddenException(
        'Only the owning organizer or an administrator may subscribe to tournament events',
      );
    await client.join(`tournament:${data.tournamentId}`);
    if (
      ['ORGANIZER', 'UMPIRE', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(
        client.data.user?.role ?? '',
      )
    )
      await client.join(`safety:tournament:${data.tournamentId}`);
    return { joined: true };
  }

  @SubscribeMessage('join:bracket')
  async handleJoinBracket(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { bracketId: string },
  ): Promise<void> {
    if (!(await this.access.canJoin(client.data.user, 'bracket', data?.bracketId)))
      throw new ForbiddenException(
        'Only authorized competition staff may subscribe to bracket events',
      );
    await client.join(`bracket:${data.bracketId}`);
    if (
      ['ORGANIZER', 'UMPIRE', 'FEDERATION_ADMIN', 'SUPER_ADMIN'].includes(
        client.data.user?.role ?? '',
      )
    )
      await client.join(`safety:bracket:${data.bracketId}`);
  }

  // ─── Server-side Broadcast Methods ──────────────────

  private emitToRooms(rooms: readonly string[], event: string, payload: unknown): void {
    if (this.server) {
      this.server.to([...rooms]).emit(event, payload);
      return;
    }
    if (this.wsBridge) {
      this.wsBridge.publishEmit('/ws/events', rooms, event, payload);
      return;
    }
    this.logger.warn(`Socket server not ready during ${event}`);
  }

  broadcastAutonomousMatchPause(payload: AutonomousMatchPausePayload): void {
    const rooms: string[] = [];
    if (payload.tournament_id) rooms.push(`safety:tournament:${payload.tournament_id}`);
    if (payload.bracket_id) rooms.push(`safety:bracket:${payload.bracket_id}`);
    if (payload.match_id) rooms.push(`safety:match:${payload.match_id}`);
    if (!rooms.length) rooms.push(`athlete:${payload.athlete_id}`);
    this.emitToRooms(rooms, 'MATCH_PAUSE_ALERT', payload);
  }

  broadcastVitalsUpdated(payload: {
    readonly tournament_id: string;
    readonly athlete_id: string;
    readonly heart_rate: number;
    readonly spo2: number;
    readonly skin_temperature: number;
    readonly severity: string;
    readonly observed_at: string;
    readonly source: string;
    readonly baseline_fields: readonly string[];
    readonly match_id?: string;
    readonly bracket_id?: string;
  }): void {
    const rooms = [`safety:tournament:${payload.tournament_id}`];
    if (payload.match_id) rooms.push(`safety:match:${payload.match_id}`);
    if (payload.bracket_id) rooms.push(`safety:bracket:${payload.bracket_id}`);
    this.emitToRooms(rooms, 'VITALS_UPDATED', payload);
  }

  broadcastScoutTalent(payload: ScoutAlertPayload): void {
    this.emitToRooms(['scouts'], 'SCOUT_TALENT_ALERT', {
      alertId: payload.alertId,
      athleteId: payload.athleteId,
      gtiScore: payload.newGti,
      sport: payload.sport,
      district: payload.district,
      state: payload.state,
      tier: payload.tierClassification,
    });
  }

  broadcastGtiUpdated(payload: GtiUpdatedPayload): void {
    this.emitToRooms([`athlete:${payload.athleteId}`], 'GTI_UPDATED', payload);
  }
}
