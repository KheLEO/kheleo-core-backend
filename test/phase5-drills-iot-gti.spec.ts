import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DrillsService } from '../src/modules/drills/drills.service';
import { DrillSignatureGuard } from '../src/modules/drills/guards/drill-signature.guard';
import { SafetyService } from '../src/modules/safety/safety.service';
import { GtiService } from '../src/modules/gti/gti.service';
import { ScoutsService } from '../src/modules/scouts/scouts.service';
import { HeatmapsService } from '../src/modules/heatmaps/heatmaps.service';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { RedisService } from '../src/infrastructure/cache/redis.service';
import { QueueProducerService } from '../src/infrastructure/queues/queue-producer.service';
import { WsEventGateway, AutonomousMatchPausePayload } from '../src/infrastructure/realtime/ws-event.gateway';
import { AlertSeverity, SportType, TierClassification } from '@prisma/client';

describe('Phase 5: Edge-AI Drills, IoT Safety Match-Pause, GTI Engine, Scout Alerts & Heatmaps', () => {
  const SHARED_SECRET = 'kheleo-drill-hmac-test-secret';

  const mockConfigService = {
    get: (key: string, defaultValue?: string) => {
      if (key === 'auth.drillHmacSecret') return SHARED_SECRET;
      return defaultValue;
    },
  } as unknown as ConfigService;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. EDGE-AI DRILL INGESTION & HMAC SECURITY
  // ──────────────────────────────────────────────────────────────────────────
  describe('Edge-AI Drill Ingestion & Cryptographic Verification', () => {
    it('ACCEPTS valid drill payload with correct HMAC-SHA256 signature and fresh timestamp', () => {
      const guard = new DrillSignatureGuard(mockConfigService);
      const athleteId = 'user-athlete-1';
      const drillType = 'CRICKET_BOWLING';
      const formScore = 88.5;
      const timestamp = Math.floor(Date.now() / 1000);

      const candidate = `${athleteId}:${drillType}:${formScore}:${timestamp}`;
      const validHmac = crypto
        .createHmac('sha256', SHARED_SECRET)
        .update(candidate)
        .digest('hex');

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              'x-drill-signature': validHmac,
            },
            body: {
              athlete_id: athleteId,
              drill_type: drillType,
              form_score: formScore,
              timestamp,
            },
          }),
        }),
      } as unknown as ExecutionContext;

      const result = guard.canActivate(mockContext);
      assert.strictEqual(result, true);
    });

    it('REJECTS drill submission when signature is tampered or invalid', () => {
      const guard = new DrillSignatureGuard(mockConfigService);
      const athleteId = 'user-athlete-1';
      const drillType = 'CRICKET_BOWLING';
      const formScore = 88.5;
      const timestamp = Math.floor(Date.now() / 1000);

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              'x-drill-signature': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
            body: {
              athlete_id: athleteId,
              drill_type: drillType,
              form_score: formScore,
              timestamp,
            },
          }),
        }),
      } as unknown as ExecutionContext;

      assert.throws(
        () => guard.canActivate(mockContext),
        (err: unknown) => {
          assert(err instanceof ForbiddenException);
          assert(err.message.includes('Invalid drill cryptographic signature'));
          return true;
        },
      );
    });

    it('REJECTS replay attack when client timestamp deviates by > 300 seconds', () => {
      const guard = new DrillSignatureGuard(mockConfigService);
      const athleteId = 'user-athlete-1';
      const drillType = 'CRICKET_BOWLING';
      const formScore = 88.5;
      const staleTimestamp = Math.floor(Date.now() / 1000) - 350; // 350s ago

      const candidate = `${athleteId}:${drillType}:${formScore}:${staleTimestamp}`;
      const signature = crypto
        .createHmac('sha256', SHARED_SECRET)
        .update(candidate)
        .digest('hex');

      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {
              'x-drill-signature': signature,
            },
            body: {
              athlete_id: athleteId,
              drill_type: drillType,
              form_score: formScore,
              timestamp: staleTimestamp,
            },
          }),
        }),
      } as unknown as ExecutionContext;

      assert.throws(
        () => guard.canActivate(mockContext),
        (err: unknown) => {
          assert(err instanceof ForbiddenException);
          assert(err.message.includes('anti-replay'));
          return true;
        },
      );
    });

    it('SUCCESSFULLY persists DrillSubmission, updates biomechanical score, and enqueues GTI recalculation', async () => {
      let createdSubmission: unknown = null;
      let updatedProfile: unknown = null;
      let enqueuedJob: unknown = null;

      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'profile-uuid',
            userId: 'user-athlete-1',
            biomechanicalScore: 70.0,
          }),
          update: async (args: Record<string, unknown>) => {
            updatedProfile = args;
            return args;
          },
        },
        drillSubmission: {
          count: async () => 1, // 1 previous submission
          create: async (args: { data: Record<string, unknown> }) => {
            createdSubmission = args.data;
            return { id: 'drill-sub-1', ...args.data };
          },
        },
        $transaction: async (
          callback: (transaction: unknown) => Promise<unknown>,
        ) => callback(mockPrisma),
      };

      const mockQueueProducer = {
        enqueueGtiRecalculation: async (payload: unknown) => {
          enqueuedJob = payload;
          return 'job-gti-1';
        },
      };

      const service = new DrillsService(
        mockPrisma as unknown as PrismaService,
        mockQueueProducer as unknown as QueueProducerService,
      );

      const result = await service.submitDrill(
        'user-athlete-1',
        {
          sport: 'CRICKET',
          drill_type: 'CRICKET_BOWLING',
          form_score: 90.0,
          frames_analyzed: 120,
          flaw_flags: ['PERFECT_RELEASE'],
          joint_angles_summary: { elbow: 165 },
          timestamp: Math.floor(Date.now() / 1000),
        },
        'signature-hash-val',
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.posture_points_awarded, 900); // 90.0 * 10
      // Cumulative: (70.0 * 1 + 90.0) / 2 = 80.0
      assert.strictEqual(result.current_biomechanical_score, 80.0);
      assert.ok(createdSubmission);
      assert.ok(updatedProfile);
      assert.deepStrictEqual(enqueuedJob, {
        athleteId: 'user-athlete-1',
        trigger: 'DRILL_SUBMISSION',
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. IOT TELEMETRY & AUTONOMOUS MATCH-PAUSE OVERRIDE
  // ──────────────────────────────────────────────────────────────────────────
  describe('IoT Telemetry & Autonomous Match-Pause Subsystem', () => {
    it('returns NORMAL when vitals are within safe athletic ranges', async () => {
      const mockPrisma = {
        healthAlert: { create: async () => {} },
      };
      const mockWs = {
        broadcastAutonomousMatchPause: () => {},
      };

      const service = new SafetyService(
        mockPrisma as unknown as PrismaService,
        mockWs as unknown as WsEventGateway,
      );

      const response = await service.processTelemetry({
        athlete_id: 'user-1',
        heart_rate: 145,
        spo2: 97,
        skin_temperature: 37.2,
      });

      assert.strictEqual(response.alert_triggered, false);
      assert.strictEqual(response.status, 'NORMAL');
    });

    it('triggers WARNING when vitals breach warning thresholds without pausing match', async () => {
      let createdAlert: Record<string, unknown> | null = null;

      const mockPrisma = {
        user: { findUnique: async () => ({ id: 'user-1' }) },
        healthAlert: {
          create: async (args: { data: Record<string, unknown> }) => {
            createdAlert = args.data;
            return { id: 'alert-1', ...args.data };
          },
        },
      };
      const mockWs = {
        broadcastAutonomousMatchPause: () => {},
      };

      const service = new SafetyService(
        mockPrisma as unknown as PrismaService,
        mockWs as unknown as WsEventGateway,
      );

      const response = await service.processTelemetry({
        athlete_id: 'user-1',
        heart_rate: 188, // > 185
        spo2: 95,
        skin_temperature: 37.8,
      });

      assert.strictEqual(response.alert_triggered, true);
      assert.strictEqual(response.status, 'WARNING');
      assert.ok(createdAlert);
      assert.strictEqual((createdAlert as { matchPaused: boolean }).matchPaused, false);
    });

    it('AUTONOMOUSLY OVERRIDES and PAUSES match when CRITICAL threshold is breached', async () => {
      let createdAlert: Record<string, unknown> | null = null;
      let broadcastEvent: AutonomousMatchPausePayload | null = null;

      const mockPrisma = {
        user: {
          findUnique: async () => ({
            id: 'user-athlete-crit',
            email: 'athlete.critical@kheleo.com',
          }),
        },
        healthAlert: {
          create: async (args: { data: Record<string, unknown> }) => {
            createdAlert = args.data;
            return { id: 'alert-crit-1', ...args.data };
          },
        },
      };

      const mockWs = {
        broadcastAutonomousMatchPause: (payload: AutonomousMatchPausePayload) => {
          broadcastEvent = payload;
        },
      };

      const service = new SafetyService(
        mockPrisma as unknown as PrismaService,
        mockWs as unknown as WsEventGateway,
      );

      const response = await service.processTelemetry({
        athlete_id: 'user-athlete-crit',
        tournament_id: 'tourney-1',
        bracket_id: 'bracket-1',
        heart_rate: 198, // Critical > 195
        spo2: 89, // Critical < 90%
        skin_temperature: 39.8, // Critical > 39.5
      });

      assert.strictEqual(response.alert_triggered, true);
      assert.strictEqual(response.status, 'MATCH_PAUSED');

      // Verify DB record
      assert.ok(createdAlert);
      assert.strictEqual((createdAlert as { matchPaused: boolean }).matchPaused, true);
      assert.strictEqual((createdAlert as { severity: AlertSeverity }).severity, AlertSeverity.CRITICAL);

      // Verify WebSocket Autonomous Override Event
      assert.ok(broadcastEvent);
      const event = broadcastEvent as unknown as AutonomousMatchPausePayload;
      assert.strictEqual(event.event, 'MATCH_PAUSE_ALERT');
      assert.strictEqual(event.severity, 'CRITICAL');
      assert.strictEqual(event.athlete_id, 'user-athlete-crit');
      assert.strictEqual(event.directive, 'MANDATORY REST: PAUSE TOURNAMENT MATCH IMMEDIATELY');
      assert.deepStrictEqual(event.vitals, {
        heart_rate: 198,
        spo2: 89,
        skin_temperature: 39.8,
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. GRASSROOTS TALENT INDEX (GTI) ENGINE & SCOUT ALERTS
  // ──────────────────────────────────────────────────────────────────────────
  describe('Grassroots Talent Index (GTI) Engine & Scout Outreaching', () => {
    it('computes composite GTI adhering precisely to formula w1=0.35, w2=0.25, w3=0.40', () => {
      const service = new GtiService(
        {} as PrismaService,
        {} as RedisService,
        {} as QueueProducerService,
        {} as WsEventGateway,
      );

      // (0.35 * 80) + (0.25 * 70) + (0.40 * 90) = 28 + 17.5 + 36 = 81.5
      const gti = service.computeCompositeGti(80, 70, 90);
      assert.strictEqual(gti, 81.5);

      // Clamps between 0 and 100
      assert.strictEqual(service.computeCompositeGti(150, 150, 150), 100.0);
      assert.strictEqual(service.computeCompositeGti(-20, -10, 0), 0.0);
    });

    it('updates DB in transaction, updates Redis leaderboards, and triggers ScoutAlert for elite rural athletes', async () => {
      let updatedProfile: unknown = null;
      let createdHistory: unknown = null;
      let createdScoutAlert: Record<string, unknown> | null = null;
      let enqueuedScoutJob: unknown = null;
      const redisCommands: Array<{ key: string; score: number; member: string }> = [];

      const mockPrisma = {
        athleteProfile: {
          findUnique: async () => ({
            id: 'profile-rural-1',
            userId: 'user-rural-prospect',
            primarySport: SportType.CRICKET,
            district: 'Dharashiv',
            state: 'Maharashtra',
            tierClassification: TierClassification.RURAL,
            isRuralOrUnderrepresented: true,
            biomechanicalScore: 92.0,
            trainingConsistencyScore: 88.0,
            matchPerformanceScore: 85.0,
            wearableScore: 88.0,
            matchPerfScore: 85.0,
            gti: 70.0,
            currentGti: 70.0,
            user: { id: 'user-rural-prospect' },
          }),
        },
        scoutAlert: {
          findFirst: async () => null, // No existing alert
          create: async (args: { data: Record<string, unknown> }) => {
            createdScoutAlert = args.data;
            return { id: 'scout-alert-1', ...args.data };
          },
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            athleteProfile: {
              update: async (args: unknown) => {
                updatedProfile = args;
                return args;
              },
            },
            gtiHistory: {
              create: async (args: unknown) => {
                createdHistory = args;
                return args;
              },
            },
            scoutAlert: {
              findFirst: async () => null,
              create: async (args: { data: Record<string, unknown> }) => {
                createdScoutAlert = args.data;
                return { id: 'scout-alert-1', ...args.data };
              },
            },
          };
          return fn(tx);
        },
      };

      const mockRedis = {
        client: {
          zadd: async (key: string, score: number, member: string) => {
            redisCommands.push({ key, score, member });
            return 1;
          },
        },
      };

      const mockQueueProducer = {
        enqueueScoutAlert: async (payload: unknown) => {
          enqueuedScoutJob = payload;
          return 'scout-job-1';
        },
      };

      const mockWs = {
        server: {
          to: () => ({ emit: () => {} }),
        },
        broadcastGtiUpdated: () => {},
      };

      const service = new GtiService(
        mockPrisma as unknown as PrismaService,
        mockRedis as unknown as RedisService,
        mockQueueProducer as unknown as QueueProducerService,
        mockWs as unknown as WsEventGateway,
      );

      // (0.35 * 92) + (0.25 * 88) + (0.40 * 85) = 32.2 + 22.0 + 34.0 = 88.2 (Breaches >= 85.0)
      const result = await service.recalculateAthleteGti('user-rural-prospect');

      assert.strictEqual(result.gti, 88.2);
      assert.strictEqual(result.eliteBreached, true);
      assert.strictEqual(result.scoutAlertTriggered, true);
      assert.deepStrictEqual(result.evidence, {
        biomechanical: 'VERIFIED',
        wearable: 'VERIFIED',
        matchPerformance: 'VERIFIED',
      });
      assert.strictEqual(result.provisional, false);

      // Verify DB Transaction
      assert.ok(updatedProfile);
      assert.ok(createdHistory);
      assert.deepStrictEqual(
        (createdHistory as { data: { calculationFactors: Record<string, unknown> } }).data
          .calculationFactors,
        {
          w1: 0.35,
          w2: 0.25,
          w3: 0.4,
          calculationVersion: 'gti-v1',
          evidence: {
            biomechanical: 'VERIFIED',
            wearable: 'VERIFIED',
            matchPerformance: 'VERIFIED',
          },
          provisional: false,
        },
      );

      // Verify Redis ZADD calls for global and district leaderboards
      assert.strictEqual(redisCommands.length, 2);
      assert.strictEqual(redisCommands[0].key, 'leaderboard:global:CRICKET');
      assert.strictEqual(redisCommands[0].score, 88.2);
      assert.strictEqual(redisCommands[1].key, 'leaderboard:district:Dharashiv:CRICKET');

      // Verify Scout Alert creation and queue dispatch
      assert.ok(createdScoutAlert);
      assert.strictEqual((createdScoutAlert as { gtiScore: number }).gtiScore, 88.2);
      assert.strictEqual((createdScoutAlert as { district: string }).district, 'Dharashiv');
      assert.ok(enqueuedScoutJob);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. SCOUT FEED & REGIONAL HEATMAPS
  // ──────────────────────────────────────────────────────────────────────────
  describe('Scout Feed & Regional Policy Heatmaps', () => {
    it('returns filtered and paginated prospects ranked by GTI in scout feed', async () => {
      const mockProfiles = [
        {
          id: 'p1',
          userId: 'u1',
          gti: 91.0,
          currentGti: 91.0,
          primarySport: SportType.CRICKET,
          district: 'Nagpur',
          state: 'Maharashtra',
          tierClassification: TierClassification.TIER_2,
          isRuralOrUnderrepresented: false,
          biomechanicalScore: 92.0,
          trainingConsistencyScore: 90.0,
          matchPerformanceScore: 91.0,
          wearableScore: 90.0,
          matchPerfScore: 91.0,
          posturePoints: 1200,
          user: { _count: { scoutAlerts: 0 } },
        },
      ];

      const mockPrisma = {
        athleteProfile: {
          count: async () => 1,
          findMany: async () => mockProfiles,
        },
      };

      const service = new ScoutsService(mockPrisma as unknown as PrismaService);
      const feed = await service.getScoutFeed({ sport: 'CRICKET', min_gti: 80 });

      assert.strictEqual(feed.success, true);
      assert.strictEqual(feed.total, 1);
      assert.strictEqual(feed.data[0].gti, 91.0);
      assert.strictEqual(feed.data[0].district, 'Nagpur');
    });

    it('formats regional participation heatmap with spatial coordinates and female pct', async () => {
      const mockPrisma = {
        $queryRaw: async () => [
          {
            district: 'Pune',
            total_athletes: 120,
            average_gti: 74.8,
            female_participation_pct: 38.5,
            centroid: '{"type":"Point","coordinates":[73.8567,18.5204]}',
          },
          {
            district: 'Solapur',
            total_athletes: 45,
            average_gti: 68.2,
            female_participation_pct: 42.0,
            centroid: '{"type":"Point","coordinates":[75.9064,17.6599]}',
          },
        ],
      };

      const service = new HeatmapsService(mockPrisma as unknown as PrismaService);
      const heatmap = await service.getRegionalHeatmap();

      assert.strictEqual(heatmap.success, true);
      assert.strictEqual(heatmap.count, 2);
      assert.strictEqual(heatmap.data[0].district, 'Pune');
      assert.strictEqual(heatmap.data[0].total_athletes, 120);
      assert.strictEqual(heatmap.data[0].average_gti, 74.8);
      assert.strictEqual(heatmap.data[0].female_participation_pct, 38.5);
      assert.deepStrictEqual(heatmap.data[0].centroid, {
        type: 'Point',
        coordinates: [73.8567, 18.5204],
      });
    });
  });
});
