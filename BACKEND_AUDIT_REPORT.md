# Kheleo Core Backend — Architecture, Claim Alignment & Deployment Audit

**Audit date:** 5 November 2026, Asia/Kolkata.
**Repository:** `kheleo-core-backend`, branch `main`.
**Audited commit:** `0067d9445048370c700f7b4bad8fa006cea43651` (`added-README.md`).
**Decision:** **NOT READY FOR PRODUCTION DEPLOYMENT.**

## 1. Executive summary and verification status

The repository contains substantial working NestJS/Fastify service logic, Prisma persistence, transactional roster creation, HMAC checks, GTI computation, and Socket.IO event producers. It does **not** implement the complete five-phase checklist. Passing compilation and the existing tests do not establish deployment readiness.

The immediate blockers are:

1. **The production start script fails after a successful build.** The build emits `dist/src/main.js`; `start:prod` executes `node dist/main`.
2. **No committed database migrations exist.** There is no executable `CREATE EXTENSION postgis`, geometry synchronization trigger, or spatial index migration. `prisma migrate deploy` cannot initialize the specified schema from this checkout.
3. **Idempotency is not scoped to the authenticated user.** A second athlete can receive the first athlete's cached response when method, route, key, and body match. An isolated execution of the actual interceptor reproduced this.
4. **Safety events disclose athlete names and vitals to anonymous sockets.** An actual local NestJS/Socket.IO gateway accepted an unauthenticated connection and delivered `MATCH_PAUSE_ALERT`. Message guards do not authenticate connections, and the gateway broadcasts globally.
5. **Two GTI inputs have no implemented ingestion workflow.** Wearable consistency and verified match performance default to 50. With these defaults and a perfect drill score, GTI reaches only **67.5**, below the 85-point scout trigger.
6. **Frontend contracts differ from the mission.** Organizer creation exists, but tournament/bracket editing and deletion, `/users/profile`, `/users/:id/dossier`, `/gti/leaderboards`, and admin verification/moderation/audit APIs are missing.

### 1.1 Scope and interpretation

Reviewed all **113 tracked files**: application source, DTOs, modules, Prisma schema, five test files, dependency manifest/lockfile, workspace/build configuration, Compose, and README. The lockfile was structurally parsed and exercised through a frozen install; this was not a package-vulnerability scan. Local `.env` names and set/empty states were inspected without copying secret values. The complete path/hash manifest is [review-manifest.json](audit-evidence/2026-11-05/review-manifest.json).

The supplied mission checklist is the available specification. The complete Five-Phase Master Plan, original Invention Disclosure Document, and actual patent claim text were not present. References to Claim 1–4 and sections 12.1–12.7 below therefore mean **source implementation alignment with the supplied checklist**, not a determination about the full documents or patent validity. The frontend repository was not audited; section 4 supplies the backend contracts for that comparison.

Initial Git state was clean; `HEAD...origin/main` was `0 0` against the existing local remote-tracking reference. No fetch was performed. Application source, existing configuration, tests, and lockfile were left unchanged. Only this report and audit evidence were added; nothing was committed, pushed, or deployed.

### 1.2 Build, schema, test, and start results

Used pnpm equivalents of the requested build/Prisma/test commands, following the workspace's package-manager instruction.

| Check | Result | Exact relevant output / evidence |
| --- | --- | --- |
| Initial `pnpm build` | FAIL, exit 1 | Missing generated Prisma exports and incomplete local dependency resolution; representative diagnostic: `Module '"@prisma/client"' has no exported member 'Prisma'.` |
| Initial `pnpm exec prisma validate` | FAIL, exit 1 | `Cannot find module '.../node_modules/prisma/build/index.js'` |
| Fresh `pnpm install --frozen-lockfile` | FAIL, exit 1 after installing packages | `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @prisma/client@6.19.3, @prisma/engines@6.19.3, @scarf/scarf@1.4.0, msgpackr-extract@3.0.4, prisma@6.19.3` — [install.log](audit-evidence/2026-11-05/install.log) |
| Explicit Prisma generation | PASS, exit 0 | `Generated Prisma Client (v6.19.3)` — [prisma-generate.log](audit-evidence/2026-11-05/prisma-generate.log) |
| Build after generation | PASS, exit 0 | `$ nest build` — [build.log](audit-evidence/2026-11-05/build.log) |
| Prisma validation after generation | PASS, exit 0 | `The schema at prisma/schema.prisma is valid 🚀` — [prisma-validate.log](audit-evidence/2026-11-05/prisma-validate.log) |
| TypeScript check | PASS, exit 0 | `tsc --noEmit` emitted no diagnostics — [typecheck.log](audit-evidence/2026-11-05/typecheck.log) |
| Existing test script | PASS, exit 0 | **33 tests passed; 0 failed**, across five independently executed test files — [test.log](audit-evidence/2026-11-05/test.log) |
| Production start after build | **FAIL, exit 1** | `$ node dist/main` followed by `Cannot find module '/Users/apple/Documents/KheLEO/KheLEO-backend/dist/main'` — [start-prod.log](audit-evidence/2026-11-05/start-prod.log) |
| Local PostgreSQL / Redis reachability | UNAVAILABLE | TCP connections to `127.0.0.1:5432` and `127.0.0.1:6379` failed. Docker, `psql`, and `redis-cli` were not available on PATH. |

Audit host: Node `v24.19.0`, pnpm `11.24.0`. Locked dependencies include NestJS `11.2.7`, Prisma `6.19.3`, TypeScript `5.9.3`, BullMQ `5.81.5`, Fastify `5.12.5`, and Socket.IO `4.8.4`. These are the locked versions inspected, not assertions about the latest available versions.

The original ignored `node_modules` was incomplete and was preserved in `/tmp/kheleo-backend-audit-2026-11-05/node_modules.original` before reinstalling. pnpm 11 rejected unapproved dependency lifecycle builds despite the repository's `onlyBuiltDependencies` setting. To execute the installed tools without changing the repository's build-approval policy, the successful audit commands were exactly:

```sh
pnpm --config.verifyDepsBeforeRun=false --config.strictDepBuilds=false exec prisma generate
pnpm --config.verifyDepsBeforeRun=false --config.strictDepBuilds=false build
pnpm --config.verifyDepsBeforeRun=false --config.strictDepBuilds=false exec prisma validate
pnpm --config.verifyDepsBeforeRun=false --config.strictDepBuilds=false test
pnpm --config.verifyDepsBeforeRun=false --config.strictDepBuilds=false exec tsc --noEmit
pnpm --config.verifyDepsBeforeRun=false --config.strictDepBuilds=false start:prod
```

The final command failed as described above. These flags were audit execution options, not a committed deployment fix. pnpm temporarily inserted `allowBuilds` placeholders into `pnpm-workspace.yaml`; that automatic edit was restored to the original committed content.

The exact test-file totals printed by the test runner were:

```text
phase2-auth-passport.spec.ts:             tests 10 | pass 10 | fail 0
phase3-tournaments-sandbagging.spec.ts:    tests  4 | pass  4 | fail 0
phase4-matchmaking-pool.spec.ts:          tests  5 | pass  5 | fail 0
phase5-drills-iot-gti.spec.ts:            tests 11 | pass 11 | fail 0
audit-hardening.spec.ts:                 tests  3 | pass  3 | fail 0
```

No live database migrations, PostGIS queries, Redis commands, BullMQ consumption, multi-process races, hardware ingestion, or deployed frontend integration were verified. The additional Socket.IO probe used real local networking and the real gateway with synthetic configuration, without the Redis adapter. Other supplemental probes used actual classes with in-memory dependencies. Results and the runnable harness are [probe-results.json](audit-evidence/2026-11-05/probe-results.json) and [probes.cjs](audit-evidence/2026-11-05/probes.cjs).

## 2. Phase-by-phase implementation and claim alignment

`[FULLY IMPLEMENTED]` means the specified source mechanism exists; it does not imply live-service validation. `[PARTIALLY IMPLEMENTED / MOCKED]` includes incomplete integration, fallback behavior, or a defect that weakens the required guarantee. `[MISSING / CONTRADICTING]` means the required contract/mechanism is absent or differs materially.

### Phase 1 — Infrastructure, database, and mobile safeguards

| Checklist item | Status | Source evidence and actual behavior |
| --- | --- | --- |
| PostgreSQL and PostGIS schema support | [FULLY IMPLEMENTED] | `prisma/schema.prisma:1` declares PostgreSQL and PostGIS 3.4; `docker-compose.yml:4` defines `postgis/postgis:16-3.4`. Geometry fields exist at schema lines 190 and 261. |
| `CREATE EXTENSION postgis` in migrations | [MISSING / CONTRADICTING] | No `prisma/migrations` files exist. The schema declaration is not a committed migration. Geometry trigger/index comments describe artifacts that are not supplied. |
| Redis 7 service and shared application cache connection | [FULLY IMPLEMENTED] | `docker-compose.yml:22`; global `RedisModule` and `RedisService`, `src/infrastructure/cache/redis.service.ts:10`. BullMQ and Socket.IO necessarily create additional dedicated connections; there is not one physical connection for every use. |
| BullMQ queue configuration | [FULLY IMPLEMENTED] | `src/infrastructure/queues/bullmq.module.ts:14` configures Redis and registers `gti-calculation`, `matchmaking`, and `scout-alerts`. Only the first two have processors. |
| Graceful shutdown wiring | [FULLY IMPLEMENTED] | `src/main.ts:71` enables Nest shutdown hooks; Prisma disconnects at `prisma.service.ts:24`; cache Redis quits with disconnect fallback at `redis.service.ts:56`; Socket.IO adapter closes clients at `redis-io.adapter.ts:47`. BullMQ lifecycle is delegated to Nest's BullMQ integration. Live teardown was not tested. |
| Strict global `ValidationPipe` | [FULLY IMPLEMENTED] | `src/main.ts:51` sets `whitelist`, `forbidNonWhitelisted`, transformation, and implicit conversion. DTO coverage is uneven; missing nested login data can still reach the service, and scalar/absent DTO parameters bypass object-field whitelisting. |
| Global RFC 7807-style error handling | [FULLY IMPLEMENTED] | `src/main.ts:61`; `src/common/filters/rfc7807-exception.filter.ts:25`; `prisma-exception.filter.ts:17`. Validation and database errors receive problem details. This does not supply a complete WebSocket error contract. |
| Gzip/Brotli | [FULLY IMPLEMENTED] | `src/main.ts:22` registers `@fastify/compress` with `['gzip', 'br']`. No constrained-phone or throughput benchmark exists. |
| Redis-backed idempotency on mutation routes | [PARTIALLY IMPLEMENTED / MOCKED] | All 18 declared mutation handlers use `IdempotencyInterceptor`. It requires a key of at least 16 characters, caches success for 86,400 seconds, and locks for 300 seconds. `src/common/interceptors/idempotency.interceptor.ts:51` omits user identity from both cache scope and fingerprint; cross-user response replay was reproduced. |
| Strict cursor pagination on every list | [PARTIALLY IMPLEMENTED / MOCKED] | All **nine explicit `findMany` calls have `take`**. That narrower property passes. Nearby discovery has an inconsistent ID cursor/distance order; scout alerts are fixed at 50 without pagination; heatmaps expose no cursor and can traverse the entire table on fallback. Several relations are capped rather than paginated. |

The explicit `findMany` bounds are: bracket suggestion `1`, bracket list `limit + 1`, GTI drill fallback `20`, heatmap batch `500`, matchmaking candidates `min(200, teamSize * 10)`, passport sports `limit + 1`, scout feed `limit + 1`, scout alerts `50`, and nearby fallback `limit * 2`. A `take` bound is not proof of a complete or correct paginated contract.

### Phase 2 — Identity, authentication, and Digital Sports Passport; section 12.1

| Checklist item | Status | Source evidence and actual behavior |
| --- | --- | --- |
| Supabase JWT integration | [MISSING / CONTRADICTING] | No Supabase dependency, project/JWKS/issuer/audience configuration, or Supabase guard exists. The service issues its own JWTs. A Supabase token is not an implemented supported contract. |
| Local `passport-jwt` RS256/HS256 verification | [FULLY IMPLEMENTED] | `src/modules/auth/strategies/jwt.strategy.ts:17`, `src/common/guards/jwt-auth.guard.ts:12`. Both RSA files must exist together; otherwise the service can use `IDENTITY_PEPPER` for HS256, including in production. Expiration and an algorithm allowlist are checked; active user/verification status is not checked per request. |
| `@CurrentUser()` | [FULLY IMPLEMENTED] | `src/common/decorators/current-user.decorator.ts:9` returns `request.user`. |
| Exact `POST /api/v1/auth/verify-gov-id` | [MISSING / CONTRADICTING] | Implemented path is **`POST /api/v1/auth/verify-government-id`**, `src/modules/auth/auth.controller.ts:71`. There is no alias for the requested spelling. |
| One-way government-ID hash stored in `IdentityVerification` | [FULLY IMPLEMENTED] | `src/modules/identity/identity.service.ts:32`: SHA-256 of normalized ID, deterministic version/type domain salt, and secret pepper. `prisma/schema.prisma:156` uniquely constrains `idHash` and `userId`. Raw ID is not persisted by these service methods. This is not Argon2 or a random per-user salt. |
| Anti-account-reset duplicate block and permanent profile reattachment | [PARTIALLY IMPLEMENTED / MOCKED] | `src/modules/auth/auth.service.ts:85` restores the **same user/profile** when the hash and either supplied contact match; different contacts receive 409. GTI/history remain attached to that unchanged profile. However identity proof is optional on registration, no actual KYC/OTP verification exists, salt rotation is unsupported, and eligibility routes do not require a verified identity. |
| `POST`, `GET`, `PATCH /api/v1/users/profile` | [MISSING / CONTRADICTING] | Actual profile routes are `POST`, `GET`, `PATCH /api/v1/passport/:userId`, `src/modules/passport/passport.controller.ts:35`. `users/:id` handles contact/account data. Sending `profile` as a UUID path parameter is not a profile API. |
| Multi-sport passport functionality | [FULLY IMPLEMENTED] | `src/modules/passport/passport.service.ts:82`, `:145`, `:178`, `:235`; passport creation/update, sport-record upsert, and paginated sport records exist. The owner can submit fields named `verifiedMetrics` and `earnedBadges`; their provenance is not verified. |
| `GET /api/v1/users/:id/dossier`, flattened scout dossier | [MISSING / CONTRADICTING] | No such controller route or dossier service exists. `ScoutDossier` is a schema model only (`prisma/schema.prisma:521`). A passport or scout-feed summary is not this contract. |

Hash normalization is `trim().toUpperCase().replace(/[\s-]/g, '')`. The exact construction is `SHA256(normalizedId + ':' + 'kheleo_anti_reset_v' + saltVersion + '_' + idType + ':' + pepper)`. Registration stores `saltVersion: 1` even when the configured hash version differs (`auth.service.ts:204`); verification binding uses the configured version (`identity.service.ts:132`). There is no lookup using historical salt/pepper versions.

### Phase 3 — Geospatial tournaments and anti-sandbagging; Claim 2 / section 12.4

| Checklist item | Status | Source evidence and actual behavior |
| --- | --- | --- |
| Organizer tournament creation | [FULLY IMPLEMENTED] | `POST /api/v1/tournaments` exists, gated to ORGANIZER/FEDERATION_ADMIN/SUPER_ADMIN, `src/modules/tournaments/tournaments.controller.ts:59`. `tournaments.service.ts:160` persists configuration and coordinates and immediately sets `REGISTRATION_OPEN`. Creation is not missing. |
| Tournament read/update/delete and organizer management list | [PARTIALLY IMPLEMENTED / MOCKED] | Public detail and nearby discovery exist. No tournament PATCH/PUT/DELETE, organizer-owned list, status transition, or moderation route exists. |
| Bracket creation/read with GTI bounds, fee, capacity | [PARTIALLY IMPLEMENTED / MOCKED] | `src/modules/brackets/brackets.controller.ts:66` and `:76`; `brackets.service.ts:199`. Creation/list exist. No update/delete or bracket-detail route exists. Any organizer can create a bracket in another organizer's tournament: the authenticated organizer ID is not passed to the service. |
| `min_gti`, `max_gti`, `entry_fee`, `prize_pool`, `max_teams`, coordinates | [PARTIALLY IMPLEMENTED / MOCKED] | Database columns use snake_case; create DTOs use **camelCase**. Tournament supports `minGti`, `maxGti`, `prizePool`, `maxTeams`, `teamSize`, `venueLat`, `venueLng`; bracket supports `minGti`, `maxGti`, `entryFee`, `maxTeams`. Fee is a bracket field. Geometry population SQL is absent. |
| Nearby route using raw PostGIS | [PARTIALLY IMPLEMENTED / MOCKED] | `src/infrastructure/database/postgis-spatial.repository.ts:49` has parameterized `ST_DWithin`, `ST_Distance`, and `ST_MakePoint`. **Any caught query error** switches to in-memory Haversine filtering of a bounded UUID-ordered subset (`tournaments.service.ts:40`). This contradicts an unconditional PostGIS-only requirement and can omit nearby tournaments. |
| Bracket registration with real-time verified GTI, 409, higher-tier suggestion, transaction | [PARTIALLY IMPLEMENTED / MOCKED] | Exact requested registration route exists. `brackets.service.ts:81` emits 409 `SANDBAGGING_DETECTED`; `:112` emits `BELOW_MINIMUM_TIER`; `:124` uses serializable creation/capacity checking. However GTI/bracket/status reads and suggestion selection happen **before** the transaction. Identity verification is not checked. The suggestion filters only the maximum, not the suggested bracket's minimum. |

Direct registration checks only the caller's `currentGti`. Optional `teamId` is not checked for captain ownership, tournament/bracket affiliation, roster eligibility, or team-average GTI. It sets `feePaid = bracket.entryFee` without payment confirmation. Registration deadlines are not enforced. Capacity counts differ between direct registration and matchmaking; these paths do not jointly establish a consistent participant/team limit.

### Phase 4 — Dynamic free-agent pool; Claim 1 / section 12.5

| Checklist item | Status | Source evidence and actual behavior |
| --- | --- | --- |
| Join/leave/status routes | [FULLY IMPLEMENTED] | `src/modules/matchmaking/matchmaking.controller.ts:23` exposes the requested nested `POST join`, `DELETE leave`, `GET status` routes. Join/leave require idempotency. Join checks profile, GTI bounds, tournament-open status, queue duplicates, and existing team membership. |
| BullMQ `matchmaking` worker | [FULLY IMPLEMENTED] | `src/modules/matchmaking/processors/matchmaking.processor.ts:8` delegates jobs to `processBracketPool`; producer uses three attempts and exponential backoff. |
| Complementary role-balancing algorithm and mean GTI bounds | [PARTIALLY IMPLEMENTED / MOCKED] | `matchmaking.service.ts:352` performs role allocation and checks rounded mean GTI. Cricket, football, and basketball have hardcoded role patterns; other sports use wildcard slots. Greedy assignment can reject a feasible roster; a four-player counterexample was reproduced. Candidates and scores are read before the transaction; individual eligibility is not rechecked at formation. |
| Atomic `Team`, `TeamMember`, free-agent state, `Registration` writes | [FULLY IMPLEMENTED] | `matchmaking.service.ts:446` uses `runSerializableTransaction`; it claims candidates conditionally, creates team/members/registration, and changes registrations to MATCHED atomically. `src/common/database/serializable-transaction.ts:6` retries Prisma P2034 conflicts up to three attempts. This does not make earlier score reads part of that transaction. |
| `MatchmakingGateway` and `ROSTER_FORMED` emission | [FULLY IMPLEMENTED] | `src/modules/matchmaking/matchmaking.gateway.ts:72` emits after successful transaction to bracket and user rooms. Clients must subscribe; delivery is not durably recorded or acknowledged. See WebSocket access gaps in section 3. |

Additional incompleteness: leave reads QUEUED then updates by ID without a status condition, so it can race formation; no transactional outbox links queue dispatch to pool insertion; only one team is formed per processor call; no periodic recovery sweep is implemented. Sport roles are client-supplied strings matched by substrings, not verified positional records. Cricket/football force a minimum roster size of four even if the tournament specifies less. More than 200 required slots cannot be satisfied by the candidate query's cap.

### Phase 5 — Drills, safety, GTI, scouts, and heatmaps; Claims 3–4 / sections 12.2, 12.3, 12.6, 12.7

| Checklist item | Status | Source evidence and actual behavior |
| --- | --- | --- |
| Drill endpoint with zero video upload | [FULLY IMPLEMENTED] | `src/modules/drills/drills.controller.ts:24`; `dto/submit-drill.dto.ts:3`. Only JSON-derived scores/metrics are bound; there is no video/multipart upload workflow or backend inference engine. Client-side Edge-AI implementation is outside this repository. |
| Drill HMAC, ±300-second window, biomechanical update, GTI enqueue | [PARTIALLY IMPLEMENTED / MOCKED] | `guards/drill-signature.guard.ts:30` verifies HMAC and drift; `drills.service.ts:38` writes submission/score/points in a serializable transaction and `:76` enqueues GTI. HMAC covers only athlete/type/score/timestamp; sport, frame count, flags, and angles can change without invalidating it. The running-average input is fetched outside the transaction. |
| Exact telemetry thresholds and HealthAlert | [FULLY IMPLEMENTED] | `src/modules/safety/safety.service.ts:20` implements HR `>195` / `>185`, SpO2 `<90` / `<93`, temperature `>39.5` / `>38.5`, with critical taking precedence. Critical alert records set `matchPaused: true`; warnings set false. |
| Autonomous persistent match pause and organizer alert | [PARTIALLY IMPLEMENTED / MOCKED] | `safety.service.ts:50` updates a supplied WARMUP/LIVE match to PAUSED_SAFETY transactionally with its alert; `:86` broadcasts. Without optional `match_id`, it still reports `MATCH_PAUSED` but changes no match. No athlete-to-match membership check, resume endpoint, or durable event delivery exists. Global broadcasting exposes the event to anonymous clients. |
| `gti-calculation` worker and weighted formula | [FULLY IMPLEMENTED] | `src/modules/gti/processors/gti-calculation.processor.ts:8`; `gti.service.ts:41`. Formula is `0.35*biomechanical + 0.25*wearable + 0.40*match`, clamped to 0–100 and rounded to two decimals. GTI/history/conditional scout alert are written in a serializable transaction. |
| Verified wearable/match score sources | [MISSING / CONTRADICTING] | No wearable-consistency ingestion or match-result/performance computation writes these component scores. They are initialized/fallback to 50 and copied forward. Telemetry does not recalculate them. MATCH_COMPLETED/WEARABLE_SYNC queue trigger names exist only in a union type. |
| National/state/district Redis rankings and `GET /gti/leaderboards` | [PARTIALLY IMPLEMENTED / MOCKED] | `gti.service.ts:197` ZADDs **global** and **district** per sport only. No state set, leaderboard-list route, or list response exists. Actual read route is `GET /api/v1/gti/rank/:sport/:athleteId`, returning one rank. Redis failures are logged and swallowed. |
| Automated rural/tier-2/tier-3 GTI ≥85 scout alerts and feed | [PARTIALLY IMPLEMENTED / MOCKED] | `gti.service.ts:137` and `:169` create an alert for qualifying classifications, deduplicated while unacknowledged; `src/modules/scouts/scouts.controller.ts:26` exposes a real feed. The condition is current score ≥85, not an actual crossing. Default data cannot reach 85 through implemented score ingestion. `scout-alerts` has no processor; the emitted `scouts` room has no subscription/automatic join. |
| Regional PostGIS aggregation, athlete count, average GTI, female percentage | [PARTIALLY IMPLEMENTED / MOCKED] | `src/modules/heatmaps/heatmaps.service.ts:27` includes the requested centroid/collect/GeoJSON functions and aggregate fields. Geometry synchronization is absent; numeric-coordinate and all-record in-memory fallbacks exist. SQL groups only by district, limits results to 500, and treats default `gti=0` differently from the fallback's `currentGti` preference. |
| Admin organizer verification, tournament moderation, security audit log APIs | [MISSING / CONTRADICTING] | No admin controller/module, organizer-verification workflow, moderation endpoint, or security audit log model/API exists. Role enums and ordinary request logging do not implement these capabilities. |

## 3. Material defects and architectural risks

### 3.1 Release blockers

| ID | Severity | Finding, impact, and source |
| --- | --- | --- |
| R1 | Blocker | **Compiled entrypoint mismatch.** `package.json:14` starts `dist/main`; `tsconfig.json` includes both application and tests without a build-specific root/exclusion, producing `dist/src/main.js` and compiled tests. Confirmed with the real build and start commands. |
| R2 | Blocker | **No reproducible database rollout.** `prisma/schema.prisma` is the only tracked Prisma file. No committed SQL initializes PostGIS, installs geometry triggers, or creates GiST spatial indexes. Compose starts infrastructure only. Schema validation checks syntax, not an actual deployed database or its extension privileges/version. |
| R3 | Critical | **Cross-user cache disclosure and skipped mutations.** Idempotency scope/fingerprint lack `request.user.sub` (`idempotency.interceptor.ts:51`). For example, two athletes joining the same bracket with identical role bodies and key receive the first athlete's registration response; the second join handler does not execute. Controller-level ownership checks inside handlers can also be skipped on a cache hit. |
| R4 | Critical | **Anonymous medical telemetry disclosure.** `ws-event.gateway.ts:129` emits `MATCH_PAUSE_ALERT` to the entire events namespace. `handleConnection` only logs (`:57`); `WsAuthGuard` protects subscribed messages, not the handshake. An actual tokenless client received the synthetic athlete's name and vitals in the audit probe. |
| R5 | High | **Missing identity authority and revocation enforcement.** Registration/login trust a supplied contact and document number, not OTP/KYC/Supabase proof (`auth.service.ts:76`, `:228`). Login computes `isVerified` but does not reject REVOKED/FLAGGED identity status. Access guards trust signed claims without loading `isActive`; refresh (`:308`) also does not check active status. Deactivation (`users.service.ts:74`) neither revokes token families nor prevents continued refresh. Recovery can reactivate accounts when hash/contact match. |
| R6 | High | **Claimed verified eligibility is not enforced.** Bracket and pool entry fetch profile/GTI, not identity verification (`brackets.service.ts:37`, `matchmaking.service.ts:48`). Registration permits omitting identity entirely. Self-written sport metrics/badges can be presented as verified (`passport.service.ts:178`). |
| R7 | High | **GTI production inputs are incomplete.** Wearable and match inputs remain defaults without an external writer. Maximum with both at 50 is `35 + 12.5 + 20 = 67.5`. The elite scout path is source-present but cannot be reached by the implemented fresh-user score workflows alone. |
| R8 | High | **Incomplete drill integrity and replay ledger.** `drill-signature.guard.ts:68` omits stored metadata from the signature; tampering was reproduced. `DrillSubmission.signatureHash` stores the original header with a case-sensitive unique string (`schema.prisma:457`); the guard accepts both hex cases. Uppercase/lowercase forms of one valid HMAC are therefore not normalized to one replay identity. No live duplicate-insert test was run. |

### 3.2 Integrity, concurrency, and reliability gaps

| ID | Severity | Finding, impact, and source |
| --- | --- | --- |
| R9 | High | **Transactional writes use stale eligibility snapshots.** Bracket GTI/bounds/status and matchmaking candidates/GTI are read before serializable transactions. A concurrent score/status change need not invalidate the later write. Bracket suggestions can point to a bracket whose minimum exceeds the athlete's score. Direct team registration does not validate the submitted team or roster (`brackets.service.ts:153`). |
| R10 | High | **Drill average and GTI overwrite races.** `drills.service.ts:28` reads the previous score outside the transaction, while `:41` counts inside. Retrying does not refresh that score. With one historic score 70, concurrent submissions 90 and 100 can use stale 70 and commit an incorrect average. `gti.service.ts:57` similarly reads components before its transaction and writes components back, potentially overwriting newer values. These are source-level race findings; no live concurrency test was available. |
| R11 | High | **Database/Redis/queue/event work is not one recoverable workflow.** Pool/drill writes commit before enqueue (`matchmaking.service.ts:187`, `drills.service.ts:75`). A queue failure can return an error after durable mutation, with no outbox to repair delivery. Roster broadcasts happen after commit without replay. GTI Redis writes can fail silently while the worker succeeds; scout queue failure happens after alert insertion and can suppress retry delivery because an unacknowledged alert then exists. |
| R12 | High | **Queue leave races matching.** `matchmaking.service.ts:215` reads a queued registration and `:228` updates by ID only. A worker can match it between these operations; leave can then overwrite MATCHED with CANCELLED while the team remains formed. |
| R13 | High | **Organizer authorization is incomplete.** Bracket creation checks role, not tournament ownership (`brackets.controller.ts:84`, `brackets.service.ts:199`). Direct registration accepts arbitrary existing `teamId`; no captain check exists. Registration counts mix individual and team concepts, and fees are marked paid without settlement. |
| R14 | High | **Safety state and context are incomplete.** Optional `match_id` means an alert can claim a pause without a match update. A signed sender can reference an unrelated athlete and match; membership is not checked. HealthAlert has no `matchId` field. Context from a valid match is not filled into omitted tournament/bracket alert fields. No match scheduling/result/resume API exists to complete that lifecycle. |
| R15 | Medium | **Pagination and spatial results can be wrong.** Nearby SQL filters `id > cursor` but orders by distance (`postgis-spatial.repository.ts:47`, `:80`), so subsequent pages can skip rows. It returns no next cursor. Haversine fallback searches only a UUID-ordered prefix, not all tournaments in radius. Scout feed has no unique ID tie-breaker after GTI sorting (`scouts.service.ts:60`). Heatmaps and alerts have no client pagination. |
| R16 | Medium | **Greedy role allocation rejects valid teams.** A BATSMAN/BOWLER dual-role candidate can be consumed as batsman ahead of a batsman-only candidate, leaving no bowler despite a feasible assignment (`matchmaking.service.ts:652`). The probe reproduced this. There is no alternate-roster search when one chosen mean GTI fails, and the bounded FIFO candidate prefix can strand specialists farther back. |
| R17 | Medium | **Leaderboards and analytics drift.** No state rankings; district keys omit state; edits to sport/district do not remove old sorted-set entries; deactivation does not remove ranks. `COALESCE(gti, current_gti, 0)` selects non-null zero instead of legacy `currentGti` in heatmap SQL, while the fallback selects `currentGti` when `gti <= 0`. Grouping by district merges same-named districts across states (`heatmaps.service.ts:39`, `:48`). |
| R18 | Medium | **Visibility and room controls are inconsistent.** Scout feed respects `isScoutSearchable`; passport reads by scout/admin, public sport-record lists, and scout-alert responses do not apply equivalent visibility filtering. Any authenticated socket can join arbitrary match/tournament/bracket rooms. Safety emits into several rooms without join handlers, and `SCOUT_TALENT_ALERT` targets an unreachable `scouts` room. |
| R19 | Medium | **Validation and domain invariants are incomplete.** Missing nested `governmentId` passes `LoginDto` validation and causes a service TypeError; reproduced. Date-of-birth/tournament dates are strings without ISO/date ordering validation. GTI bounds can be reversed/out of range; fees/prize pools can be negative; roster sizes lack practical upper limits. Telemetry values are numeric but have no plausibility bounds; several ID fields are plain strings. |
| R20 | Medium | **Identity-version and duplicate-model ambiguity.** Registration persists salt version 1 while hashing with the configured version; historical version lookup/pepper rotation are absent. `gti/currentGti`, wearable/match score pairs, team GTI/formation pairs, and `FreeAgentPool`/`FreeAgentRegistration` coexist. Several read paths prefer different copies. `IdempotencyRecord` and `ScoutDossier` have no active API/persistence workflow; identity records cascade on physical user deletion. |
| R21 | Medium | **Runtime/toolchain and operational gaps.** No pinned `packageManager` or Node `engines`, application Dockerfile, CI workflows, readiness/liveness endpoints, deployment manifest, migration gate, or documented rollback/restore procedure. pnpm 11 frozen installation encountered lifecycle-policy incompatibility. Redis connections have no configured TLS/ACL username support or startup timeout. API and both workers run in the same application process. |

### 3.3 Hardcoded, fallback, and incomplete behavior inventory

- **Identity/auth:** fixed deterministic domain salt; `saltVersion: 1` during registration; access lifetime 900 seconds and refresh lifetime seven days despite configurable-looking expiry variables; development fallback secret strings; public role restricted to ATHLETE. No actual OTP or document-authority verification.
- **Profile defaults:** initial `currentGti=30`, `gti=0`, wearable/match legacy scores 50, new sport role `GENERAL_ATHLETE`, empty metrics/badges. Those are starting/default values, not measured athletic evidence.
- **Matchmaking:** hardcoded regex role quotas; generic wildcard sports; missing-profile GTI fallbacks of 30 for mean calculation and 50 for displayed rosters; contact data used as player name; random `FA-Roster-XXXX` name; minimum four cricket/football slots; first member marked captain but `Team.captainId` is not assigned.
- **Geospatial/heatmaps:** executable Haversine/in-memory fallbacks, not sample data; no geometry trigger implementation; heatmap SQL cap of 500 districts versus an uncapped fallback result and full-table traversal. Fallback stores coordinate arrays proportional to the number of athletes with coordinates.
- **GTI/scouts:** default/fallback 50 component inputs; fallback drill sample capped at 20 without recency ordering; a score of zero is treated as absent in several `||`/`>0` branches. Scout alerts use current score ≥85 plus an unacknowledged-alert check, not a transition from below 85. Acknowledging then recalculating can create another alert without a new threshold crossing. `scout-alerts` jobs have no worker.
- **Safety:** NORMAL telemetry is not persisted; only warnings/critical alerts are. Critical response can say MATCH_PAUSED without a match. No device enrollment, per-device signing key, persisted telemetry replay identity, or match resume flow exists. Replays with a new idempotency key remain possible within the timestamp window.
- **Payments/admin/dossiers:** `feePaid` is assigned from configured fee; no payment integration. Organizer verification, privileged account provisioning API, moderation, and security audit trails are absent. Dossier is schema-only.

The production services generally call real Prisma/Redis/BullMQ interfaces. The fake data and fake transaction callbacks are in tests. The principal production incompleteness is missing workflows, unsafe fallbacks/defaults, and missing authorization/recovery guarantees, rather than universal placeholder controllers.

## 4. Complete implemented REST contract inventory

### 4.1 Shared wire rules

- HTTP API prefix: **`/api/v1`** (`src/main.ts:47`). All routes below include that prefix. Documentation is configured at `/docs` (Swagger UI and generated documentation assets/JSON/YAML are framework documentation endpoints, not additional business controllers).
- JSON bodies use `Content-Type: application/json`.
- **J** means `Authorization: Bearer <locally issued access token>`.
- **I** means required `Idempotency-Key` with at least 16 characters. All 18 POST/PATCH/DELETE handlers require it.
- **D** means `X-Drill-Signature`; **T** means `X-Device-Signature`. Their exact formats are in section 4.5.
- `?` denotes an optional field, not a casing alias. Except where noted, enum values are uppercase. DTO field spelling/casing is significant; unknown bound DTO fields receive 400.
- Most UUID path parameters use `ParseUUIDPipe`. GTI parameters and scout acknowledgement ID do not; service/database handling then determines invalid-ID behavior.
- `Accept-Encoding: gzip` or `br` negotiates compression; it is optional. CORS allows Content-Type, Authorization, Idempotency-Key, X-Drill-Signature, X-Device-Signature, X-Timestamp, and If-None-Match; it exposes ETag, X-Cache-Lookup, and X-Request-Id. The code does not implement ETags, conditional reads, or a request-ID generator merely by listing these headers.

Successful response notation:

```text
E(value) = { success: true, data: value, timestamp: ISO8601-string }
Page<T>  = { data: T[], next_cursor: UUID|null, has_more: boolean, count: number }
```

`ResponseTransformInterceptor` wraps ordinary values in E. It leaves a value with a top-level `success` or `type` property unchanged. Thus drill, scout-feed, and heatmap responses are **not** wrapped again. A paginated sports/bracket result **is** wrapped, giving `response.data.data` for its rows. Dates serialize as ISO strings. Raw Prisma Decimal fields serialize as **strings**; explicitly mapped DTO numbers remain numbers.

Errors have `Content-Type: application/problem+json` and `{type,title,status,detail,instance,timestamp,invalidParams?}`. Object-valued `HttpException` extras such as `code`, `athleteGti`, and `suggestedBracketId` appear at the top level. Common statuses: 400 invalid/missing DTO or idempotency input; 401 missing/invalid JWT or login/refresh credentials; 403 ownership/role/HMAC failure; 404 absent resource; 409 duplicates/capacity/tier/idempotency conflict; 500 unexpected error. Database unique/not-found/foreign-key errors are translated by the Prisma filter. Failed responses are not cached as successes.

### 4.2 Every business HTTP operation

| Method and exact route | Success | Required headers / authorization | Request | Returned shape |
| --- | --- | --- | --- | --- |
| POST `/api/v1/auth/register` | 201 | I; public | `Register` | `E(AuthTokens)`; existing identity/contact can restore original account |
| POST `/api/v1/auth/login` | 200 | I; public | `Login` | `E(AuthTokens)` |
| POST `/api/v1/auth/verify-government-id` | 200 | J, I | `VerifyGovId` | `E({message,verified,idHashPrefix})` |
| POST `/api/v1/auth/refresh` | 200 | I; refresh token in body | `{refreshToken:string}` | `E(AuthTokens)` |
| GET `/api/v1/auth/me` | 200 | J | None | `E({sub,role,email?,phone?,iat?,exp?})`; current JWT claims, not a loaded profile |
| GET `/api/v1/users/:id` | 200 | J; self or SUPER_ADMIN | UUID `id` | `E(User)` |
| PATCH `/api/v1/users/:id` | 200 | J, I; self or SUPER_ADMIN | UUID `id`; `{phone?:string,email?:string}` | `E(User)` |
| DELETE `/api/v1/users/:id` | 200 | J, I; self or SUPER_ADMIN | UUID `id`; no body | `E(User)` with `isActive:false`; soft deactivation |
| GET `/api/v1/passport/:userId` | 200 | J; self, SCOUT, FEDERATION_ADMIN, or SUPER_ADMIN | UUID `userId` | `E(Passport)` |
| POST `/api/v1/passport/:userId` | 201 | J, I; self or SUPER_ADMIN | UUID `userId`; `CreatePassport` | `E(Passport)` |
| PATCH `/api/v1/passport/:userId` | 200 | J, I; self or SUPER_ADMIN | UUID `userId`; `UpdatePassport` | `E(Passport)` |
| POST `/api/v1/passport/:userId/sports` | 200 | J, I; self or SUPER_ADMIN | UUID `userId`; `SportRecordInput` | `E(SportRecord)` |
| GET `/api/v1/passport/:userId/sports` | 200 | Public | UUID `userId`; `limit?`, **`cursor_id?`** | `E(Page<SportRecord>)` |
| GET `/api/v1/tournaments/nearby` | 200 | Public | `lat,lng,radius_km?,sport?,limit?,` **`cursor?`** | `E(NearbyTournament[])`; no page metadata |
| GET `/api/v1/tournaments/:id` | 200 | Public | UUID `id` | `E(Tournament & {brackets:Bracket[]})`; brackets capped at 100 |
| POST `/api/v1/tournaments` | 201 | J, I; ORGANIZER, FEDERATION_ADMIN, or SUPER_ADMIN | `CreateTournament` | `E(Tournament)` |
| GET `/api/v1/tournaments/:tournamentId/brackets` | 200 | Public | UUID `tournamentId`; `limit?`, **`cursor_id?`** | `E(Page<Bracket>)` |
| POST `/api/v1/tournaments/:tournamentId/brackets` | 201 | J, I; ORGANIZER, FEDERATION_ADMIN, or SUPER_ADMIN | UUID `tournamentId`; `CreateBracket` | `E(Bracket)`; ownership of tournament not checked |
| POST `/api/v1/tournaments/:tournamentId/brackets/:bracketId/register` | 201 | J, I | Both UUIDs; `{teamId?:UUID}` | `E(BracketRegistration)` |
| POST `/api/v1/tournaments/:tournamentId/brackets/:bracketId/free-agents/join` | 201 | J, I | Both UUIDs; `{primary_role:string,secondary_role?:string}` | `E(FreeAgentState)`; initial response omits optional matched-roster fields |
| DELETE `/api/v1/tournaments/:tournamentId/brackets/:bracketId/free-agents/leave` | 200 | J, I | Both UUIDs; no body | `E({message:string,cancelled:true})` |
| GET `/api/v1/tournaments/:tournamentId/brackets/:bracketId/free-agents/status` | 200 | J | Both UUIDs | `E(FreeAgentState)`; latest registration, including cancelled/matched state |
| POST `/api/v1/drills/submit` | 200 | J, I, D; submitted athlete must equal token subject | `SubmitDrill` | Bare `{success:true,posture_points_awarded:number,current_biomechanical_score:number}` |
| POST `/api/v1/safety/telemetry-webhook` | 200 | I, T; no JWT required | `Telemetry` | `E({alert_triggered:boolean,status:'NORMAL'\|'WARNING'\|'MATCH_PAUSED',message?:string})` |
| POST `/api/v1/gti/recalculate/:athleteId` | 200 | J, I; token subject must equal `athleteId`, or FEDERATION_ADMIN/SUPER_ADMIN | String ID; no body | `E(GtiResult)`; service resolves user ID first, then profile ID, but ordinary self authorization compares against user ID |
| GET `/api/v1/gti/rank/:sport/:athleteId` | 200 | Public | String `sport`, string `athleteId`; `district?:string` | `E({sport,athleteId,rank:number\|null})`; no leaderboard rows |
| GET `/api/v1/scouts/feed` | 200 | J; SCOUT, FEDERATION_ADMIN, or SUPER_ADMIN | `sport?,district?,min_gti?,cursor_id?,limit?` | Bare `{success:true,total:number,limit:number,next_cursor:UUID\|null,data:Prospect[]}` |
| GET `/api/v1/scouts/alerts` | 200 | J; same scout/admin roles | `sport?:string,district?:string`; no cursor/limit contract | `E(ScoutAlertWithAthlete[])`, at most 50 |
| PATCH `/api/v1/scouts/alerts/:id/acknowledge` | 200 | J, I; same scout/admin roles | String `id`; no body | `E(ScoutAlert)`; acknowledgement is global to that alert, not per scout |
| GET `/api/v1/heatmaps/regional` | 200 | Public | No bound query/body fields | Bare `{success:true,count:number,data:DistrictHeatmap[]}` |

The actual controller metadata generates **30 HTTP operations across 24 distinct paths**. [openapi.json](audit-evidence/2026-11-05/openapi.json) was generated from those real controllers with stub service providers; it is supplementary evidence, not proof of running infrastructure. Several routes lack Swagger DTO/response/security annotations, so the README instruction to treat Swagger as an authoritative complete schema is too strong.

### 4.3 Exact input DTO fields and validation

| Input | Fields and implemented validation |
| --- | --- |
| `GovernmentIdInput` | **camelCase** `idType:GovIdType`, `idNumber:string` nonempty. Used by Register/Login. Unlike dedicated VerifyGovId, this nested type has no minimum length beyond nonempty. |
| `InitialAthleteProfile` | **camelCase** required `dateOfBirth:string`, `gender:string`, `primarySport:SportType`, `district:string`, `state:string`; optional `secondarySports:SportType[]`, `tierClassification:TierClassification`, `heightCm:number`, `weightKg:number`, `dominantSide:string`. Required strings must be nonempty; date is not ISO-validated. Secondary sports have per-value enum validation but no explicit array validator. |
| `Register` | `phone?:string`, `email?:string`, `role?:UserRole`, `profile?:InitialAthleteProfile`, `governmentId?:GovernmentIdInput`. Service requires at least phone or email, returning 409 if absent. Phone regex `^\+?[1-9]\d{7,14}$`; email validated. Only ATHLETE is accepted for public registration, even though DTO lists all roles. Both profile and identity are optional. |
| `Login` | `phone?:string`, `email?:string`, intended required `governmentId:GovernmentIdInput`. Phone/email validation matches Register. Service requires a contact. Missing nested governmentId is not rejected by its decorators and can produce 500 after an existing user is resolved. No OTP/password field is accepted. |
| `VerifyGovId` | `idType:GovIdType`, `idNumber:string`, nonempty and minimum four characters. |
| Refresh / UpdateUser | Refresh: nonempty `refreshToken:string`. UpdateUser: optional validated `phone`, optional validated `email`; no role/active/profile properties. |
| `CreatePassport` | Required `dateOfBirth:string`, `gender:string`, `primarySport:SportType`, `district:string`, `state:string`. Optional `secondarySports:SportType[]`, `tierClassification`, `heightCm:number` 50–260, `weightKg:number` 20–200, `dominantSide:string`, `locationLat:number`, `locationLng:number`, `isScoutSearchable:boolean`. Coordinates have no latitude/longitude range decorators; dominantSide's documented enum is not enforced. Date is a nonempty string. |
| `UpdatePassport` | Optional `primarySport`, `secondarySports`, `district`, `state`, `tierClassification`, `heightCm` 50–260, `weightKg` 20–200, `dominantSide`, `locationLat`, `locationLng`, `isScoutSearchable`. **No** `dateOfBirth`, `gender`, GTI, wearable, or match score field. |
| `SportRecordInput` | Required `sport:SportType`, nonempty `primaryRole:string`; optional `secondaryRoles:string[]`, `verifiedMetrics:object`, `earnedBadges:object[]`. Actual badges validation checks array, not each element's object structure. Service upserts by profile/sport. |
| `CreateTournament` | Required `name:string`, `sport:SportType`, `maxTeams:integer >=2`, `teamSize:integer >=1`, `venueName:string`, valid `venueLat`, valid `venueLng`, and nonempty strings `registrationDeadline`, `startDate`, `endDate`. Optional numeric `minGti` default 0, `maxGti` default 100, `prizePool` default 0. No body `organizerId`, `status`, `entryFee`, or snake_case aliases. No cross-field GTI/date validation. |
| `CreateBracket` | Required `name:string`, `tierName:string`, `minGti:number`, `maxGti:number`; optional `entryFee:number` default 0, `maxTeams:integer >=2` default 16, `bracketType:BracketType` default SINGLE_ELIMINATION. No `prizePool`, coordinate, `roundOrder`, or `config` input field. |
| RegisterBracket / JoinFreeAgent | RegisterBracket: optional **camelCase** `teamId:UUID`. JoinFreeAgent: required nonempty **snake_case** `primary_role:string`; optional `secondary_role:string`. Output returns camelCase outer fields. |
| `SubmitDrill` | **snake_case** optional `athlete_id:string`; required `sport:string`, `drill_type:string`, `form_score:number` 0–100, `frames_analyzed:integer >=1`, `timestamp:number`. Optional `flaw_flags:string[]\|object`, `joint_angles_summary:object`; their declared structures have no runtime type validators beyond `IsOptional`. No video field. |
| `Telemetry` | **snake_case** required `athlete_id:string`, `heart_rate:number`, `spo2:number`, `skin_temperature:number`; optional `tournament_id:string`, `bracket_id:string`, `match_id:UUID`. `timestamp` is written as optional in TypeScript but has `IsNumber` without `IsOptional`, and the guard requires it at runtime. Seconds or milliseconds accepted. No JWT athlete binding or device ID field. |
| Common cursor query | `limit:integer` default 20, range 1–100; **`cursor_id?:UUID`**. Used for passport sport records and bracket lists. |
| Nearby query | Required numeric valid `lat`, `lng`; optional **`radius_km:integer`** default 50, range 1–1000; `sport?:SportType`, **`cursor?:UUID`**, `limit:integer` default 20, range 1–100. |
| Scout feed query | `sport?:string`, `district?:string`, **`min_gti?:number >=0`**, **`cursor_id?:UUID`**, `limit?:integer` 1–100, service default 20. No upper bound on min_gti. Valid sport strings are uppercased; an unknown sport is silently ignored as a filter. |
| Scalar/no-DTO queries | Rank binds `district`; alerts bind `sport,district`; heatmaps bind no query. Unknown query keys on these handlers are not rejected through a query DTO. Handlers without body DTOs do not acquire body whitelisting merely from the global pipe. |

Relevant enums:

```text
UserRole: ATHLETE | SCOUT | UMPIRE | ORGANIZER | FEDERATION_ADMIN | SUPER_ADMIN
GovIdType: AADHAAR | VOTER_ID | PASSPORT | DRIVING_LICENSE | BIRTH_CERTIFICATE
SportType: CRICKET | FOOTBALL | BADMINTON | ATHLETICS | BASKETBALL | KABADDI
TierClassification: RURAL | TIER_3 | TIER_2 | TIER_1 | METRO
BracketType: SINGLE_ELIMINATION | DOUBLE_ELIMINATION | ROUND_ROBIN | SWISS
VerificationStatus: UNVERIFIED | VERIFIED | FLAGGED_DUPLICATE | REVOKED
FreeAgentStatus: QUEUED | MATCHING | MATCHED | CANCELLED | EVALUATING | EXPIRED | WITHDRAWN
```

### 4.4 Exact response fields

| Shape | Fields inside E, or inside a named bare response |
| --- | --- |
| `AuthTokens` | `accessToken:string, refreshToken:string, tokenType:'Bearer', expiresIn:900, user:{id,phone:string\|null,email:string\|null,role,isVerified:boolean,athleteProfileId:UUID\|null}` |
| `User` | `id,phone,email,role,isActive,createdAt,updatedAt` |
| `Passport` | `userId,athleteProfileId,dateOfBirth,gender,primarySport,secondarySports,district,state,tierClassification,physicalStats:{heightCm:number\|null,weightKg:number\|null,dominantSide:string\|null},currentGti:number,wearableScore:number,matchPerfScore:number,posturePoints:number,identityStatus,sportRecords:SportSummary[],allBadges:object[]` |
| `SportSummary` | `id,sport,primaryRole,secondaryRoles,totalMatches,winCount,winStreak,verifiedMetrics,earnedBadges,updatedAt`. Passport includes at most 20, sufficient for the six current sport enum values. |
| `SportRecord` | All SportSummary fields plus `athleteId` (the **AthleteProfile ID**). Raw upsert/list Prisma shape. |
| `Tournament` | `id,organizerId,name,title,sport,status,minGti:string,maxGti:string,maxTeams:number,teamSize:number,prizePool:string,currency,venueName,venueLat:number,venueLng:number,registrationDeadline,startDate,endDate,rulesConfig,createdAt,updatedAt`. Unsupported geometry fields are not selected/returned by these Prisma calls. Detail adds `brackets`. |
| `Bracket` | `id,tournamentId,name,tierName,minGti:string,maxGti:string,entryFee:string,maxTeams:number,bracketType,roundOrder:number,config` |
| `NearbyTournament` | **camelCase** `id,name,sport,status,minGti:number,maxGti:number,venueName,venueLat:number,venueLng:number,distanceKm:number,startDate,registrationDeadline,prizePool:number,maxTeams:number,teamSize:number`. Distance rounded to one decimal. |
| `BracketRegistration` | **camelCase** `registrationId,bracketId,tournamentId,athleteId,tierName,athleteGti:number,status,feePaid:number,registeredAt,teamId:UUID\|null`. Here **athleteId is profile ID**, not token/user ID. |
| `FreeAgentState` | **camelCase** `registrationId,userId,tournamentId,bracketId,sport,primaryRole,secondaryRole:string\|null,status,waitPosition:number,joinedAt`; status response also supplies `matchedTeamId:UUID\|null,teamName:string\|null,assignedRole:string\|null,roster:RosterMember[]\|null`. Join omits optional matching fields. |
| `RosterMember` | **snake_case** `user_id:string,name:string,assigned_role:string,gti:number`. Name uses email, then phone, then a fallback label; this is not a stored display-name field. |
| `GtiResult` | **camelCase** `athleteId` (user ID), `gti:number,previousGti:number,biomechanicalScore:number,wearableScore:number,matchPerformanceScore:number,eliteBreached:boolean,scoutAlertTriggered:boolean` |
| `Prospect` | **snake_case** `athlete_id` (user ID), `profile_id,gti,primary_sport,district,state,tier,is_rural_or_underrepresented,biomechanical_score,training_consistency_score,match_performance_score,posture_points,alert_count` |
| `ScoutAlert` | **camelCase** `id,athleteId` (user ID), `gtiScore:number,district,sport,isAcknowledged:boolean,createdAt` |
| `ScoutAlertWithAthlete` | ScoutAlert fields plus `athlete:{id,email,phone,athleteProfile:{id,primarySport,currentGti:string,district,state}\|null}` |
| `DistrictHeatmap` | **snake_case** `district,total_athletes:number,average_gti:number,female_participation_pct:number,centroid:GeoJSON-Point\|null`. Coordinates ordered `[longitude,latitude]`. No state field. |

Anti-sandbagging 409 responses add top-level `code:'SANDBAGGING_DETECTED', athleteGti, bracketMaxGti, bracketMinGti, suggestedBracketId:UUID|null, suggestedBracketTier:string|null`. The **free-agent join** variant has the code and GTI bounds but **does not** return the suggested bracket fields. Below-minimum responses use `code:'BELOW_MINIMUM_TIER'` and bounds.

### 4.5 HMAC, timestamps, and idempotency details

Drill signature is a 64-character hexadecimal HMAC-SHA256 using `DRILL_HMAC_SECRET`, over either:

```text
<athlete user ID>:<drill_type>:<form_score>:<provided numeric timestamp>
<athlete user ID>:<drill_type>:<form_score>:<timestamp normalized to integer seconds>
```

The guard resolves athlete from `athlete_id`, legacy `athleteId`, or JWT subject, in that order. The legacy camelCase body property is not in the DTO and is rejected by the validation pipe. Drift uses normalized seconds and allows an absolute difference up to 300 seconds. `X-Timestamp` is a guard fallback only; it does not eliminate the DTO's body-timestamp requirement. Sport/frame/flags/angle values are outside this signature. Signed inputs must be produced by a trusted signer; this backend contains no signer/device provisioning protocol.

Telemetry signature is a 64-character hexadecimal HMAC-SHA256 using `TELEMETRY_SERVICE_HMAC_SECRET` over **`JSON.stringify(request.body)` after JSON parsing**, not retained raw HTTP bytes and not sorted-key canonical JSON. The signer must reproduce property order and JSON serialization. Body timestamp is normalized from milliseconds when greater than `1e11`; drift over 300 seconds is rejected.

Idempotency stores successful handler bodies and HTTP status for 24 hours. A matching replay gets `X-Cache-Lookup: IDEMPOTENT_HIT`; a different body or in-flight identical scope gets 409. The fingerprint uses `JSON.stringify(body ?? null)`, so JSON member order matters. Query strings are excluded from scope. No user/tenant scope exists. A signed request's guard runs before the cache interceptor, so an expired HMAC timestamp can prevent a replay even though the success cache still exists. The five-minute lock is not renewed or deleted with an ownership token; a request outliving it is not guaranteed exactly-once execution. The database `IdempotencyRecord` model is unused by this interceptor.

### 4.6 Missing frontend-facing contracts

These are absent, and should be presented as blocked frontend capabilities until implemented or explicitly remapped:

- `POST /api/v1/auth/verify-gov-id`; actual path contains `verify-government-id`.
- `POST /api/v1/users/profile`, `GET /api/v1/users/profile`, `PATCH /api/v1/users/profile`; actual profile API is `/passport/:userId`.
- `GET /api/v1/users/:id/dossier`; no equivalent flattened dossier endpoint.
- `GET /api/v1/gti/leaderboards`; rank-only route does not supply a leaderboard table.
- Tournament/bracket PATCH/PUT/DELETE; organizer-owned tournament listing; tournament status/moderation workflow.
- Organizer verification, admin security-audit logs, role assignment/provisioning, and administrative account-management lists.
- Match scheduling/results, wearable-consistency ingestion, match-performance scoring, safety-alert listing/acknowledgement, and match-resume endpoints.

## 5. Complete WebSocket contract inventory

Transport is **Socket.IO**, default engine path `/socket.io`; namespaces are independent of the REST prefix. Clients can supply `auth:{token:'<JWT>'}` or an `Authorization: Bearer <JWT>` handshake header. Those credentials are checked when a subscribed message executes. There is no connection middleware that rejects a tokenless handshake, and no implemented automatic room joins.

### 5.1 Client-to-server subscription messages

| Namespace | Event | Exact body | Room / access check | Success response |
| --- | --- | --- | --- | --- |
| `/ws/matchmaking` | `join:user` | `{userId:string}` | `user:<userId>`; message JWT required; userId must equal JWT subject | Handler returns void; no explicit success acknowledgement |
| `/ws/matchmaking` | `join:bracket` | `{bracketId:string}` | `bracket:<bracketId>`; message JWT required; no bracket membership/role check | Void |
| `/ws/events` | `join:match` | `{matchId:string}` | `match:<matchId>`; message JWT required; no match membership/role check | Void |
| `/ws/events` | `join:athlete` | `{athleteId:string}` | `athlete:<athleteId>`; self or SCOUT/ORGANIZER/FEDERATION_ADMIN/SUPER_ADMIN | Void; unauthorized identity comparison returns silently |
| `/ws/events` | `join:tournament` | `{tournamentId:string}` | `tournament:<tournamentId>`; message JWT required; no tournament membership/ownership check | Void |

Inline TypeScript body types are not validated DTO classes; no UUID/field whitelist contract is enforced for these payloads. No leave events, event replay, durable acknowledgement, or role-room subscription messages exist.

### 5.2 Server-to-client events

| Namespace | Event and exact payload | Actual delivery |
| --- | --- | --- |
| `/ws/matchmaking` | `ROSTER_FORMED`: `{event:'ROSTER_FORMED',data:{team_id,team_name,bracket_id,roster:[{user_id,name,assigned_role,gti}]}}` | Bracket room, then each matched user's room. A client in both can receive duplicate events because these are separate emits. |
| `/ws/events` | `MATCH_PAUSE_ALERT`: `{event:'MATCH_PAUSE_ALERT',severity:'CRITICAL',athlete_id,athlete_name,vitals:{heart_rate,spo2,skin_temperature},directive,tournament_id?,bracket_id?,match_id?}` | Emits to supplied tournament/bracket/match contexts, organizer/umpire rooms, global role rooms, and **every connection in the namespace**. Some targeted rooms have no join implementation. |
| `/ws/events` | `GTI_UPDATED`: `{athleteId,previousGti,newGti,eliteBreached}` | `athlete:<user ID>` room only |
| `/ws/events` | `SCOUT_TALENT_ALERT`: `{athleteId,gtiScore,sport,district,state,tier}` | `scouts` room only; **no handler or automatic join populates this room** |

Rooms with the same string in different namespaces are separate. A client joining a bracket on `/ws/matchmaking` does not join that bracket's room on `/ws/events`. The Redis adapter is source-configured for cross-instance fan-out, but live Redis fan-out and shutdown were not exercised.

## 6. Deployment requirements from the owner

### 6.1 Complete environment inventory

The local `.env` contains **17 keys**; `.env.example` contains **16**. Their union is **18**. The local file lacks `CORS_ORIGINS`; it includes unused OTP keys absent from the example. Secret values are deliberately not reproduced. [environment-keys.json](audit-evidence/2026-11-05/environment-keys.json) records names and set/empty status.

| Variable | Current local presence | Implemented default / use | Owner requirement |
| --- | --- | --- | --- |
| `NODE_ENV` | Set | `development`; controls production secret checks | Set `production` for production. |
| `PORT` | Set | `3000`; listen host is hardcoded `0.0.0.0` | Supply application port/ingress routing. `main.ts` reads the environment value directly. |
| `APP_NAME` | Set | `kheleo-core-backend`; loaded into config | Optional label; Swagger title and other names are hardcoded independently. |
| `CORS_ORIGINS` | **Absent**; present in example | Comma-separated list, default `http://localhost:3000` | Supply exact production browser origins. Redis Socket.IO adapter applies the same origin list. |
| `DATABASE_URL` | Set | Required by Prisma datasource; config fallback empty | PostgreSQL connection URL, credentials, schema, and provider-required SSL configuration. Do not use example credentials. |
| `REDIS_HOST` | Set | `localhost`; cache/queues/pub-sub | Reachable Redis host. |
| `REDIS_PORT` | Set | `6379` | Reachable Redis port. |
| `REDIS_PASSWORD` | **Empty** | Optional; no username/TLS configuration is wired | Provide password where required; provision compatible private networking or implement provider-required TLS/ACL settings before deployment. |
| `JWT_PRIVATE_KEY_PATH` | Set | `./keys/private.pem` | Supply readable RSA private key if using RS256. |
| `JWT_PUBLIC_KEY_PATH` | Set | `./keys/public.pem` | Supply matching public key. Both files must exist or neither; RSA presence is checked at startup. |
| `JWT_ACCESS_EXPIRY` | Set | Config exposes `15m`, **service ignores it** | Actual lifetime is hardcoded 900 seconds; change requires implementation work. |
| `JWT_REFRESH_EXPIRY` | Set | Config exposes `7d`, **service ignores it** | Actual lifetime is hardcoded seven days. |
| `IDENTITY_PEPPER` | Set | Empty config default; required by IdentityService in production | Strong persistent secret, required even with RSA JWT keys; protect continuity because no pepper-rotation migration exists. It is also the HS256 secret when RSA is absent. |
| `IDENTITY_SALT_VERSION` | Set | `1`; config parsed as integer | Keep consistent with stored identities; fix stored-version mismatch and historical lookup before rotating. |
| `DRILL_HMAC_SECRET` | Set | Required in production; explicit development fallback in guard | Secret for trusted drill signer plus a provisioning/signing integration. Do not expose this shared secret in a browser bundle. |
| `TELEMETRY_SERVICE_HMAC_SECRET` | Set | Required in production; config default empty | Secret for the telemetry sender plus a real sender/device integration. In development, an empty configured string can remain the HMAC key because the guard uses `??`, not `\|\|`. |
| `OTP_EXPIRY_SECONDS` | Set; absent from example | **Unused**; no source reads it | No OTP service exists for this setting to configure. |
| `OTP_LENGTH` | Set; absent from example | **Unused** | Same limitation. |

There is no environment schema enforcing numeric ranges, secret strength, URL validity, or cross-field consistency. Nonempty placeholder secrets satisfy current production presence checks. Supabase URL/key/JWKS variables, Redis TLS/username/database variables, and observability credentials are not implemented configuration contracts.

### 6.2 External services and operational inputs

| Required input | Actual repository support / required work |
| --- | --- |
| PostgreSQL with PostGIS 3.4 | Compose specifies PostgreSQL 16/PostGIS 3.4. Owner must supply database, credentials, extension availability/creation privileges, connection limits, network access, durable backups, and a restore procedure. Commit/apply reviewed migrations, geometry synchronization, and spatial indexes before using a fresh production database. |
| Redis 7 | Compose provides Redis 7 with AOF and a named volume. Application uses Redis for idempotency, queue storage, rank sets, and pub/sub. Persistence/retention, credentials, network policy, and capacity must be provisioned for those workloads. Database state alone does not reconstruct queue/cache/rank state. |
| Application runtime | Supply Node/pnpm versions pinned and tested for this lockfile, dependencies, generated Prisma client, compiled JavaScript, correct entrypoint, and process supervision. README says Node 20+; this audit actually ran Node 24.19.0. No engines/packageManager pin exists. |
| Trusted identities and privileged users | Supply an implemented identity/OTP/Supabase integration or accept that current code only trusts supplied document/contact data. Organizer/scout/admin accounts cannot be created through public registration; an authorized provisioning path is required. |
| Trusted drill and telemetry producers | Supply the actual metrics/sensor integrations and shared-secret management. Backend accepts derived values; it does not perform video inference, enroll devices, or generate measured wearable/match scores. |
| HTTP/WebSocket hosting | Supply host/domain, TLS termination, allowed frontend origins, HTTP port mapping, Socket.IO `/socket.io` upgrade forwarding, and appropriate process/network limits. API and queue workers start together; there is no independent worker command. |
| Operational monitoring | Supply application/queue/error monitoring and health/readiness behavior. There is no application health endpoint or application container healthcheck. Infrastructure healthchecks in Compose cover only Postgres and Redis. |
| Delivery automation | No `.github/workflows/**`, Dockerfile, production app service, deployment manifest, migration gate, or rollback script is supplied. These remain deployment work, not configured features. |

Compose is a local infrastructure definition: it contains fixed example database credentials, publishes database/Redis ports, runs Redis without authentication, and has no API container. It must not be mistaken for a complete production backend deployment.

### 6.3 Build/start commands and rollout boundary

The intended script sequence is:

```sh
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm exec prisma validate
pnpm test
pnpm build
pnpm prisma:deploy
pnpm start:prod
```

**That sequence is currently blocked:** pnpm 11 lifecycle policy needs a pinned compatible configuration; migrations are absent; `pnpm start:prod` points at a nonexistent output file. It is a description of the intended script flow, not a deployable runbook or a report that deployment passed. Prisma CLI and build/test tools are dev dependencies, so they must be present in the build/migration stage.

The actual emitted entrypoint can be invoked as:

```sh
NODE_ENV=production node dist/src/main.js
```

This is an entrypoint workaround only. It was not validated against live PostgreSQL/Redis and does not resolve the security, migration, or contract blockers. `prisma db push` is documented for local schema initialization; it is not the missing reviewed migration history. No database mutation, `db push`, or migration deployment was run during this audit.

## 7. Test quality and required evidence before release

The 33 passing tests instantiate services with fake Prisma, Redis, queue, gateway, and transaction objects. The `$transaction` fakes invoke callbacks; they do not reproduce PostgreSQL isolation, constraints, retry races, or atomic rollback. They provide useful unit-level evidence for selected business branches.

Specific limitations in the existing tests:

- `test/phase2-auth-passport.spec.ts:223` tests the length of a manually constructed JSON payload, not the actual signed JWT size or guard behavior. No token revocation, deactivated refresh, missing nested login DTO, or external identity integration test exists.
- `test/phase3-tournaments-sandbagging.spec.ts:212` mocks the spatial repository's returned row. It does not execute SQL, exercise PostGIS extension/index setup, or verify distance/cursor consistency.
- `test/phase4-matchmaking-pool.spec.ts:339` labels a test as insufficient specialists, but its bracket fixture omits `tournamentId`; the method returns false at the affiliation check before evaluating candidates. That test can pass while role-shortage handling is broken.
- `test/phase5-drills-iot-gti.spec.ts:267` labels a test as pausing a match, but supplies no `match_id` or match transaction mock. It verifies HealthAlert flags and a mocked broadcast; it never verifies a Match row transition.
- Scout GTI tests seed wearable/match components above their defaults. They do not establish a real workflow that measures or updates these values.
- Heatmap tests inject precomputed aggregate rows, so they cannot detect the SQL/fallback zero-score discrepancy, grouping collisions, spatial prerequisites, or whole-table memory cost.
- The three idempotency regressions cover missing keys, changed bodies, and route separation. They do not cover user separation, lock expiry, transaction/Redis failure recovery, or signed-request retry behavior.

Release evidence still required after fixes:

1. A clean, pinned-toolchain install/build/start gate using the actual production command and artifact.
2. Fresh-database migration deployment with PostGIS, geometry synchronization/indexes, and round-trip spatial queries.
3. Auth/identity/visibility tests covering unverified, revoked, deactivated, cross-user, organizer-ownership, and missing-input cases.
4. Concurrent registration/pool/leave/drill/GTI tests against real PostgreSQL and Redis, including rollback, capacity, retry, and delivery-failure recovery.
5. Real BullMQ processing, Redis rankings/fan-out, authenticated Socket.IO connection/room access, private safety delivery, and scout-room delivery.
6. A complete measured wearable/match GTI input path, durable safety pause/resume lifecycle, and frontend contract acceptance tests for the actual routes/shapes.

## 8. File coverage and evidence artifacts

The complete 113-file review inventory, line counts, and SHA-256 hashes are in [review-manifest.json](audit-evidence/2026-11-05/review-manifest.json). It identifies the exact source snapshot, including every module wiring file, DTO, helper, configuration file, test, lockfile, and README. Source paths cited throughout this report refer to that snapshot.

| Area | Files reviewed / purpose |
| --- | --- |
| Root configuration and documentation | `.env.example`, `.gitignore`, `.prettierrc.json`, `README.md`, `docker-compose.yml`, `nest-cli.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` |
| Database | `prisma/schema.prisma`; all `src/infrastructure/database/*.ts` |
| Bootstrap/configuration | `src/main.ts`, `src/app.module.ts`, all six `src/config/*.ts` |
| Shared infrastructure/contracts | All files under `src/common` and `src/infrastructure/cache`, `queues`, `realtime` |
| Domain modules | Every controller/service/module/DTO/guard/processor/gateway under auth, identity, users, passport, tournaments, brackets, matchmaking, drills, safety, gti, scouts, and heatmaps |
| Tests | All five `test/*.spec.ts` files; every test file ran in the existing script |
| Explicitly absent artifacts | No committed Prisma migrations, `.github/workflows` files, app Dockerfile, admin module, full invention disclosure, or full master plan |

Raw verification logs, generated controller OpenAPI, redacted environment inventory, and supplemental probe results are stored in `audit-evidence/2026-11-05/`. No secret values or copied `.env` file were included. Findings that require production infrastructure are explicitly marked as source-level or unverified rather than inferred from the passing unit tests.
