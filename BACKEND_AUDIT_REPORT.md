# Backend final full-stack acceptance audit

- **Date:** 6 November 2026, Asia/Kolkata.
- **Repository:** KheLEO/kheleo-core-backend.
- **Verified code:** `49fd2dc495903a890e080c7e2cc59590aea0fd35`, plus documentation/evidence only.
- **Decision:** **READY FOR PRODUCTION DEPLOYMENT** for the verified release artifacts on Node 22/24. Owner environment acceptance remains required.

## Current verification evidence

All requested gates pass: Prisma generation/validation, strict TypeScript, production build, **196 tests**, **five active exploit probes**, both compiled entrypoints and native production integration. The entire frontend/backend src trees were rescanned; content hashes are in [source-audit.json](audit-evidence/2026-11-06/source-audit.json).

Fresh hosted verification: [Node 22/24 native PostGIS/Redis and containers](https://github.com/KheLEO/kheleo-core-backend/actions/runs/42140215984), code commit above. Both jobs pass migrations against PostgreSQL 16/PostGIS, Redis 7, production start, health/docs/CORS, authenticated Socket.IO, BullMQ and non-root container health. The full embedded PostGIS WASM suite runs on Node 24; Node 22 separately compiles and exercises native runtime gates. Local audit host Node 24.19.0 lacks Docker/native database binaries, so local compile results are not presented as native boot evidence.

| Evidence               | Result                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Node 22         | [Smoke](audit-evidence/2026-11-06/node-22/ci-smoke-results.json), [probes](audit-evidence/2026-11-06/node-22/probe-results.json), [entrypoints](audit-evidence/2026-11-06/node-22/entrypoint-results.json) |
| Native Node 24         | [Smoke](audit-evidence/2026-11-06/node-24/ci-smoke-results.json), [probes](audit-evidence/2026-11-06/node-24/probe-results.json), [entrypoints](audit-evidence/2026-11-06/node-24/entrypoint-results.json) |
| Current HTTP contracts | [65 operations / 53 paths](audit-evidence/2026-11-05/route-inventory.json), [OpenAPI](audit-evidence/2026-11-05/openapi.json)                                                                              |
| Frontend acceptance    | 213 Vitest tests, 61 Chromium journeys, contracts/lint/format/types/build; all 54 relay rules map to real controllers                                                                                      |

Native measured components are biomechanical **96**, wearable **100**, match **100**, GTI **98.6**. Scout talent delivery succeeds; athlete and scout competition medical deliveries are **zero**. Authorized owner receives two at-least-once pause deliveries, and the outbox drains. Smoke additionally reads organizer summary/mine/rosters/wall, full scout dossier/outreach history, audit filters and queue/PostGIS health. These are real endpoint executions against native services, not controller inventory alone.

Test-file totals: 41 auth/passport, 4 tournaments, 14 matchmaking, 20 drills/safety/GTI, 61 audit-hardening, 6 health, 17 PostGIS migration, 12 release-readiness, 9 organizer, 5 scout and 7 admin tests: **196**, zero failed/skipped.

## Prompt 5 corrections

The asynchronous drill guard is now awaited by the active exploit harness. Production smoke follows confidential staff rooms, explicit medical dispatch/clearance bodies, raw cursor-page response shapes and an acknowledged room-join barrier. The Docker default and native CI reference use supported Node 22/24. The additive `20261106040000_release_acceptance` migration preserves incident IDs, simulator source labels and baseline tags in recovered safety events; dispatcher tests and migrated SQL assertions cover provenance.

Frontend production contact login is now wired to Supabase OTP acquisition/verification before platform register/login; pending organizer/scout signup displays an approval notice. Provider calls exclude government identity fields and backend production proof validation remains mandatory. Email/SMS delivery and independent government-document review are deployment-owner checks.

## Active exploit probes

Five neutralization probes pass with no reproduced vulnerability: user-scoped idempotency (both actors execute), signed metadata tampering (original and three mutations rejected), missing nested government-ID validation (400 before service invocation), exact non-greedy role assignment, and anonymous medical-event rejection (zero anonymous deliveries). The probes use controlled dependencies plus actual loopback Socket.IO; they do not prove absence of all possible vulnerabilities.

`probes.original.cjs` and `probe-results.original.json` are archived vulnerable baselines and intentionally retain historical failing assertions. Only the active harness is an acceptance gate. Entrypoint probes deliberately use unavailable infrastructure to prove resolution/DI; native CI separately proves successful startup.

## R1–R21 closure ledger

Closed below means the original implementation defect is remediated in the production profile. Environmental verification and compatibility qualifications are stated rather than hidden.

| ID  | Status and concrete remediation                                                                                                                                                                                                                                    | Verification / source                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | CLOSED — src-only build emits dist/main.js; legacy dist/src/main.js delegates to it                                                                                                                                                                                | package.json, tsconfig.build.json, scripts/create-entrypoint-shim.cjs; entrypoint and native CI smoke                                                                                                                                                  |
| R2  | CLOSED — committed baseline, draft-profile, security/GTI and release-recovery migrations create schema, PostGIS synchronization and indexes                                                                                                                        | prisma/migrations; PGlite schema/geometry/index tests and native migration CI; extension privileges remain a deployment prerequisite                                                                                                                   |
| R3  | CLOSED — idempotency fingerprint/key bind authenticated actor, method, full URL and canonical body; lock release checks ownership                                                                                                                                  | IdempotencyInterceptor; probe 1 and cache/lock regressions; auth token issuance always revalidates credentials                                                                                                                                         |
| R4  | CLOSED — handshake verification, immediate rejection, private athlete/staff scopes; no global medical emit                                                                                                                                                         | WsAuthGuard, RoomAccessService, WsEventGateway; probe 5 and actual socket tests                                                                                                                                                                        |
| R5  | CLOSED — production register/login require provider-verified confirmed contact proof; new identity hashes remain UNVERIFIED pending administrator checks; revocation/active state enforced across HTTP, refresh and sockets; admin suspension blocks self-recovery | contact-proof.ts, account-access.ts, JwtStrategy, AuthService, AdminService; release authority/recovery tests. Provider confirmation and document approval are not simulated KYC                                                                       |
| R6  | CLOSED — verified identity, complete passport and current GTI checked before entry; self-written verified counters/metrics rejected                                                                                                                                | participation-policy.ts, BracketsService, MatchmakingService, PassportService; auth/eligibility tests                                                                                                                                                  |
| R7  | CLOSED — distinct monitored days, verified result ledger/counters, signed drills and queued calculation supply all components; evidence/provisional flags prevent unsupported outreach                                                                             | SafetyService, MatchResultsService, GtiService, ScoutAlertsProcessor; measured GTI 98.6 regression and native smoke. JWT telemetry is authenticated self-report, not sensor attestation                                                                |
| R8  | CLOSED — normalized lowercase replay identity, strict types/coherence/18000-frame guard, full/full-v2 signing in production; legacy local records remain explicitly unverified                                                                                     | DrillSignatureGuard, SubmitDrillDto, DrillsService, normalization trigger; probe 2, casing/tamper tests and SQL duplicate tests                                                                                                                        |
| R9  | CLOSED — participation/candidate/roster reads and writes share serializable transactions and repeat on retries; bracket recommendations satisfy both bounds                                                                                                        | BracketsService, MatchmakingService; retry injection, team ownership/live-roster tests                                                                                                                                                                 |
| R10 | CLOSED — drill average snapshot/count and GTI components/evidence read inside serializable transactions; recalculation writes only derived GTI/history                                                                                                             | DrillsService, GtiService; retry/rollback regressions                                                                                                                                                                                                  |
| R11 | CLOSED — source-transaction SQL triggers persist delivery intents; leased dispatcher retries queue/cache/event publication across restart; scout jobs have stable IDs                                                                                              | release-recovery migration, OutboxDispatcher, QueueProducerService; SQL rollback, failure/restart and competing dispatcher tests. Delivery is at least once; durable REST snapshots recover offline state                                              |
| R12 | CLOSED — pool leave conditionally transitions only QUEUED, preserving a committed worker claim                                                                                                                                                                     | MatchmakingService.leavePool; conditional-state regressions including SQL execution                                                                                                                                                                    |
| R13 | CLOSED — organizer ownership/captain/live-roster authorization; mutation invariants/capacity enforced; feePaid stays zero without settlement                                                                                                                       | tournament-policy.ts, BracketsService, MatchResultsService, MatchmakingService; owner/captain/foreign-team tests. No payment gateway is claimed                                                                                                        |
| R14 | CLOSED — physiological bounds/freshness, athlete/match membership, canonical context, actual pauses only, acknowledgement/resume authority and unresolved-critical checks                                                                                          | safety module, HealthAlert match/ack fields, result endpoint; lifecycle HTTP tests and native smoke                                                                                                                                                    |
| R15 | CLOSED — distance/UUID spatial cursors, full fallback scan, unique scout-feed ordering; scout alerts accept cursor_id/limit with X-Next-Cursor; regional fallback matches cap and uses constant-size coordinate sums                                               | PostgisSpatialRepository, TournamentsService, ScoutsService/Controller, HeatmapsService; distance/pagination tests and SQL execution. Nearby returns data/next_cursor/has_more with distance/UUID keyset ordering; frontend also accepts legacy arrays |
| R16 | CLOSED — exact backtracking role assignment, identity uniqueness, mean-GTI feasibility and complete eligible queue traversal                                                                                                                                       | role-matcher.ts, MatchmakingService; probe 4, dual-role/alternate-roster tests and brute-force comparisons                                                                                                                                             |
| R17 | CLOSED — global/state/legacy district/state-qualified district ZSETs; old memberships removed or repaired through outbox; DB leaderboard fallback; heatmaps group state+district with NULLIF zero fallback                                                         | LeaderboardsService, HeatmapsService; scope/move/opt-out/SQL tests. Redis is a cache, not the source of component truth                                                                                                                                |
| R18 | CLOSED — opt-in visibility on discovery/dossiers/outreach; self-only athlete rooms, staff ownership/assignment, automatic scouts room; union targeting deduplicates each roster broadcast                                                                          | scouts/passport/realtime modules; visibility and actual Socket.IO room tests. Recovery notifications can repeat by design                                                                                                                              |
| R19 | CLOSED — required nested login ID, ISO demographics/date ordering, GTI/fee/capacity/UUID/telemetry validation; admin status bodies reject invalid nulls/booleans                                                                                                   | DTOs, domain policies and guards; probe 3 and HTTP boundary tests                                                                                                                                                                                      |
| R20 | CLOSED — configured/current historical salt lookup and stored version alignment; canonical component writers, evidence flags and synchronized compatibility fields; dossier/idempotency workflows; permanent identity deletion restricted                          | IdentityService, GtiService, PassportService, migrations; identity rotation, preservation and restrictive-FK tests. Pepper rotation still requires a deliberate migration plan                                                                         |
| R21 | CLOSED — pinned pnpm/runtime requirements, lifecycle allowlist, multi-stage image, migration gate, healthcheck, CI, operational guide, Redis URL/TLS/ACL and bounded connect/startup                                                                               | Dockerfile, .dockerignore, verify.yml, redis-options.ts, validate-environment.ts, deployment guide. Node 22 is the production reference; Node 24 also passes native integration and the embedded PostGIS suite                                         |

## Complete REST inventory

Extracted from actual compiled controllers. Roles, ownership, DTO validation and idempotency remain enforced by controller guards/services; the frontend relay independently restricts methods, bodies, roles and identity scope. Auth login/register require confirmed provider contact proof in production. The four portal inventories are synchronized and checked by frontend route-coverage tests.

| Method | Exact path                                                                      | Controller operation                      |
| ------ | ------------------------------------------------------------------------------- | ----------------------------------------- |
| POST   | `/api/v1/auth/register`                                                         | `AuthController_register_v1`              |
| POST   | `/api/v1/auth/login`                                                            | `AuthController_login_v1`                 |
| POST   | `/api/v1/auth/verify-government-id`                                             | `AuthController_verifyGovernmentId[0]_v1` |
| POST   | `/api/v1/auth/verify-gov-id`                                                    | `AuthController_verifyGovernmentId[1]_v1` |
| POST   | `/api/v1/auth/refresh`                                                          | `AuthController_refreshToken_v1`          |
| POST   | `/api/v1/auth/logout`                                                           | `AuthController_logout_v1`                |
| GET    | `/api/v1/auth/me`                                                               | `AuthController_getProfile_v1`            |
| GET    | `/api/v1/users/profile`                                                         | `UsersController_getProfile_v1`           |
| POST   | `/api/v1/users/profile`                                                         | `UsersController_upsertProfile_v1`        |
| PATCH  | `/api/v1/users/profile`                                                         | `UsersController_updateProfile_v1`        |
| GET    | `/api/v1/users/{id}/dossier`                                                    | `UsersController_getDossier_v1`           |
| GET    | `/api/v1/users/{id}`                                                            | `UsersController_findById_v1`             |
| PATCH  | `/api/v1/users/{id}`                                                            | `UsersController_update_v1`               |
| DELETE | `/api/v1/users/{id}`                                                            | `UsersController_deactivate_v1`           |
| GET    | `/api/v1/passport/{userId}`                                                     | `PassportController_getPassport_v1`       |
| POST   | `/api/v1/passport/{userId}`                                                     | `PassportController_createPassport_v1`    |
| PATCH  | `/api/v1/passport/{userId}`                                                     | `PassportController_updatePassport_v1`    |
| POST   | `/api/v1/passport/{userId}/sports`                                              | `PassportController_addSportRecord_v1`    |
| GET    | `/api/v1/passport/{userId}/sports`                                              | `PassportController_listSportRecords_v1`  |
| GET    | `/api/v1/tournaments`                                                           | `TournamentsController_list_v1`           |
| POST   | `/api/v1/tournaments`                                                           | `TournamentsController_create_v1`         |
| PATCH  | `/api/v1/tournaments/{id}`                                                      | `TournamentsController_update_v1`         |
| DELETE | `/api/v1/tournaments/{id}`                                                      | `TournamentsController_delete_v1`         |
| GET    | `/api/v1/tournaments/{id}`                                                      | `TournamentsController_findById_v1`       |
| GET    | `/api/v1/tournaments/nearby`                                                    | `TournamentsController_findNearby_v1`     |
| POST   | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/register`              | `BracketsController_register_v1`          |
| GET    | `/api/v1/tournaments/{tournamentId}/brackets`                                   | `BracketsController_findByTournament_v1`  |
| POST   | `/api/v1/tournaments/{tournamentId}/brackets`                                   | `BracketsController_createBracket_v1`     |
| PATCH  | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}`                       | `BracketsController_updateBracket_v1`     |
| DELETE | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}`                       | `BracketsController_deleteBracket_v1`     |
| POST   | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/free-agents/join`      | `MatchmakingController_joinPool_v1`       |
| DELETE | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/free-agents/leave`     | `MatchmakingController_leavePool_v1`      |
| GET    | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/free-agents/status`    | `MatchmakingController_getStatus_v1`      |
| POST   | `/api/v1/drills/submit`                                                         | `DrillsController_submit_v1`              |
| POST   | `/api/v1/safety/telemetry-webhook`                                              | `SafetyController_telemetry_v1`           |
| GET    | `/api/v1/safety/alerts`                                                         | `SafetyController_alerts_v1`              |
| PATCH  | `/api/v1/safety/alerts/{id}/acknowledge`                                        | `SafetyController_acknowledge_v1`         |
| POST   | `/api/v1/safety/matches/{matchId}/resume`                                       | `SafetyController_resume_v1`              |
| GET    | `/api/v1/safety/tournaments/{tournamentId}/vitals`                              | `SafetyController_vitals_v1`              |
| GET    | `/api/v1/safety/tournaments/{tournamentId}/alerts`                              | `SafetyController_history_v1`             |
| POST   | `/api/v1/gti/recalculate/{athleteId}`                                           | `GtiController_recalculate_v1`            |
| GET    | `/api/v1/gti/leaderboards`                                                      | `GtiController_leaderboards_v1`           |
| GET    | `/api/v1/gti/rank/{sport}/{athleteId}`                                          | `GtiController_getRank_v1`                |
| POST   | `/api/v1/scouts/dossiers/{athleteId}/outreach`                                  | `ScoutsController_outreach_v1`            |
| GET    | `/api/v1/scouts/feed`                                                           | `ScoutsController_getFeed_v1`             |
| GET    | `/api/v1/scouts/alerts`                                                         | `ScoutsController_getAlerts_v1`           |
| PATCH  | `/api/v1/scouts/alerts/{id}/acknowledge`                                        | `ScoutsController_acknowledgeAlert_v1`    |
| GET    | `/api/v1/heatmaps/regional`                                                     | `HeatmapsController_getRegional_v1`       |
| GET    | `/api/v1/admin/dashboard`                                                       | `AdminController_dashboard_v1`            |
| GET    | `/api/v1/admin/users`                                                           | `AdminController_users_v1`                |
| PATCH  | `/api/v1/admin/users/{id}/status`                                               | `AdminController_status[0]_v1`            |
| PATCH  | `/api/v1/admin/users/{id}/governance`                                           | `AdminController_status[1]_v1`            |
| GET    | `/api/v1/admin/tournaments`                                                     | `AdminController_tournaments_v1`          |
| PATCH  | `/api/v1/admin/tournaments/{id}/status`                                         | `AdminController_moderate[0]_v1`          |
| PATCH  | `/api/v1/admin/tournaments/{id}/moderation`                                     | `AdminController_moderate[1]_v1`          |
| GET    | `/api/v1/admin/audit-logs`                                                      | `AdminController_audit_v1`                |
| GET    | `/api/v1/health`                                                                | `HealthController_check_v1`               |
| POST   | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/matches/record-result` | `MatchResultsController_record_v1`        |
| POST   | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/matches/results`       | `MatchResultsController_results_v1`       |
| GET    | `/api/v1/tournaments/organizer/summary`                                         | `OrganizerController_summary_v1`          |
| GET    | `/api/v1/tournaments/organizer/mine`                                            | `OrganizerController_mine_v1`             |
| GET    | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/registrations`         | `OrganizerController_registrations_v1`    |
| GET    | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/free-agents/pool`      | `OrganizerController_pool_v1`             |
| POST   | `/api/v1/tournaments/{tournamentId}/brackets/{bracketId}/free-agents/process`   | `OrganizerController_process_v1`          |
| GET    | `/api/v1/tournaments/{tournamentId}/sandbagging-logs`                           | `OrganizerController_logs_v1`             |

Standard responses use `{success,data,timestamp}`; already-wrapped success pages and health preserve their own shape. Cursor conventions are endpoint-specific. Nearby uses `{data,next_cursor,has_more}`; leaderboard/admin pages use their declared cursor contract; scout alert arrays expose `X-Next-Cursor`.

## Production handoff

Follow [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) for PostgreSQL 16/PostGIS, Redis 7 persistence/noeviction, Node 22, RSA/secrets, complete backend/frontend environments, migration/build/start, Supabase OTP, initial SUPER_ADMIN and pending staff, TLS/WebSocket proxy, assets, owner checks and rollback.

This verdict concerns release software under verified configuration. It does not certify a deployed owner environment, external message delivery, physical device/camera authenticity, sports-science validity, clinical escalation, settlement payments, patent validity or capacity targets. Signed browser reports and reference scoring windows do not establish hardware attestation. Owner health, contact delivery, TLS, role isolation, backups, camera/BLE and capacity checks remain explicit deployment acceptance steps.
