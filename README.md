# Kheleo Core Backend

The central API for Kheleo's athlete identity, digital sports passports, tournament discovery, anti-sandbagging, free-agent matchmaking, Edge-AI drill ingestion, player-safety telemetry, Grassroots Talent Index (GTI), and scout discovery workflows.

The service is a NestJS 11 application running on Fastify. PostgreSQL/PostGIS stores durable and geospatial data, Redis supports idempotency, leaderboards, queues, and Socket.IO fan-out, and BullMQ runs matchmaking and GTI recalculation jobs.

## What the service implements

- Permanent athlete identity based on one-way government-ID hashes. Raw ID numbers are never persisted.
- Athlete sports passports with multi-sport records, physical attributes, GTI history, and scout visibility.
- Nearby tournament discovery through PostGIS, with a bounded Haversine fallback.
- Bracket-level GTI limits that reject both overqualified and below-tier entrants.
- Transactional, role-balanced free-agent team formation with realtime roster notifications.
- Signed Edge-AI drill submissions. Only derived scores and metrics are accepted; the API has no raw-video upload path.
- Signed wearable telemetry with warning and critical thresholds. A critical reading can pause an active match and emit `MATCH_PAUSE_ALERT`.
- Weighted GTI calculation, Redis leaderboards, regional heatmaps, and elite-talent scout alerts.
- RFC 7807 error responses, strict request validation, cursor pagination, response compression, and Redis-backed idempotency.

## Architecture

```text
Mobile and web clients        Edge-AI clients        Wearable gateway
          |                         |                       |
          +-------------------------+-----------------------+
                                    |
                         REST + Socket.IO
                                    |
                     NestJS 11 / Fastify API
             +----------------------+---------------------+
             |                      |                     |
     PostgreSQL 16 + PostGIS     Redis 7              BullMQ workers
     Prisma persistence,         idempotency,         matchmaking and
     spatial queries             rankings, pub/sub    GTI recalculation
```

The application is organized by domain under `src/modules`, with shared guards, filters, interceptors, and pagination types under `src/common`. Infrastructure adapters live under `src/infrastructure`.

## Technology stack

| Area                         | Implementation                                                           |
| ---------------------------- | ------------------------------------------------------------------------ |
| Runtime                      | Node.js 20+ and TypeScript 5                                             |
| API                          | NestJS 11 with Fastify 5                                                 |
| Validation and documentation | `class-validator`, `class-transformer`, OpenAPI/Swagger                  |
| Database                     | PostgreSQL 16, PostGIS 3.4, Prisma 6                                     |
| Cache and jobs               | Redis 7, BullMQ 5                                                        |
| Realtime                     | Socket.IO with the Redis adapter                                         |
| Authentication               | Locally issued JWTs; RS256 with a key pair or HS256 development fallback |
| Cryptography                 | Node.js `crypto` for government-ID hashing and HMAC verification         |

## Prerequisites

- Node.js 20 or newer
- pnpm 10.32.0 (pinned in `package.json`; Corepack selects this version)
- Docker with Docker Compose, or compatible PostgreSQL/PostGIS and Redis instances

## Local setup

1. Install dependencies and create the local environment file.

   ```bash
   pnpm install --frozen-lockfile
   cp .env.example .env
   ```

2. Replace the example secrets in `.env`. Never use the checked-in placeholder values outside local development.

3. Start PostgreSQL/PostGIS and Redis.

   ```bash
   docker compose up -d
   ```

4. Apply the committed baseline to an empty development database. Dependency installation already generates Prisma Client.

   ```bash
   pnpm prisma:deploy
   ```

   The baseline initializes all tables, PostGIS, coordinate synchronization triggers, and spatial indexes. It requires permission to create the PostGIS extension. Use `pnpm exec prisma migrate dev --name <migration_name>` for subsequent schema changes; preserve custom trigger and expression-index SQL when reviewing migrations. Existing databases created with `db push` need a reviewed baseline reconciliation before deployment, including renaming `venue_geom`/`location_geom` to `location` and installing the triggers and indexes. Do not mark the baseline applied until the database matches it.

5. Start the API.

   ```bash
   pnpm start:dev
   ```

The default API base URL is `http://localhost:3000/api/v1`. Interactive OpenAPI documentation is available at `http://localhost:3000/docs`.

## Environment variables

| Variable                        | Purpose                                                   | Development default                              |
| ------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `NODE_ENV`                      | Runtime environment and production security checks        | `development`                                    |
| `PORT`                          | HTTP and Socket.IO port                                   | `3000`                                           |
| `APP_NAME`                      | Application name                                          | `kheleo-core-backend`                            |
| `CORS_ORIGINS`                  | Comma-separated allowed browser origins                   | `http://localhost:3000`                          |
| `DATABASE_URL`                  | PostgreSQL connection string                              | See `.env.example`                               |
| `REDIS_HOST`                    | Redis host used by cache, queues, and realtime            | `localhost`                                      |
| `REDIS_PORT`                    | Redis port                                                | `6379`                                           |
| `REDIS_PASSWORD`                | Optional Redis password                                   | Empty                                            |
| `JWT_PRIVATE_KEY_PATH`          | RSA private key path                                      | `./keys/private.pem`                             |
| `JWT_PUBLIC_KEY_PATH`           | RSA public key path                                       | `./keys/public.pem`                              |
| `JWT_ACCESS_EXPIRY`             | Access-token lifetime in seconds or s/m/h/d/w duration    | `15m`                                            |
| `JWT_REFRESH_EXPIRY`            | Opaque refresh-token lifetime in the same duration format | `7d`                                             |
| `SUPABASE_JWT_SECRET`           | Optional additional HS256 JWT verification authority     | Empty                                            |
| `ADMIN_INVITE_CODE`             | Required invitation for SUPER_ADMIN registration         | Empty                                            |
| `IDENTITY_PEPPER`               | Secret pepper for government-ID hashes and HS256 fallback | Required in production if no RSA pair is present |
| `IDENTITY_SALT_VERSION`         | Government-ID hash domain version                         | `1`                                              |
| `DRILL_HMAC_SECRET`             | Shared secret for signed drill submissions                | Required in production                           |
| `TELEMETRY_SERVICE_HMAC_SECRET` | Shared secret for signed telemetry payloads               | Required in production                           |

JWT key files are optional in local development. If either configured key file exists, both must exist; the service then signs and verifies with RS256. Without the pair it uses `IDENTITY_PEPPER` as an HS256 secret. The current token lifetimes are 15 minutes for access tokens and 7 days for refresh tokens.

Generate a local RSA pair when testing the production-style JWT path:

```bash
mkdir -p keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out keys/private.pem
openssl rsa -pubout -in keys/private.pem -out keys/public.pem
```

## Commands

| Command                | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `pnpm start:dev`       | Start the API in watch mode                  |
| `pnpm start:debug`     | Start watch mode with the Node debugger      |
| `pnpm build`           | Compile the NestJS application to `dist/`    |
| `pnpm start:prod`      | Run the compiled application                 |
| `pnpm format`          | Format TypeScript files under `src/`         |
| `pnpm prisma:generate` | Generate Prisma Client                       |
| `pnpm prisma:migrate`  | Create/apply a development migration         |
| `pnpm prisma:deploy`   | Apply committed migrations                   |
| `pnpm test`            | Run the seven project spec suites            |

Run `pnpm build` before `pnpm start:prod`. The build emits `dist/main.js` and a compatibility shim at `dist/src/main.js`; both entrypoints start the same application. Build output excludes tests and audit evidence.

`GET /api/v1/health` is public and requires no headers. It returns `{ status, db, redis, uptime }` directly, with HTTP 200 for `status: "ok"` or HTTP 503 for `status: "degraded"`. Database and Redis probes run concurrently with a one-second deadline each; dependency results are `"ok"` or `"unavailable"`, and uptime is measured in seconds.

## Authentication and request integrity

Authentication is intentionally passwordless in this service. Public athlete registration accepts a phone number or email and may bind a government ID. Login requires the same verified contact plus the government-ID proof. The normalized ID is hashed with a versioned domain salt and `IDENTITY_PEPPER`; only the hash is stored.

If registration supplies a government ID already attached to the same contact, the existing permanent profile is reactivated and returned without changing its contacts or historical GTI. A matching ID with a different contact is rejected. Registration accepts `ATHLETE`, `ORGANIZER`, and `SCOUT`; `SUPER_ADMIN` requires a matching `adminInviteCode` and server `ADMIN_INVITE_CODE`. Other privileged roles cannot self-register.

Login, refresh, and authenticated HTTP requests reject deactivated accounts and identities marked `REVOKED` or `FLAGGED_DUPLICATE`. Deactivation also revokes stored refresh tokens. Token lifetimes follow `JWT_ACCESS_EXPIRY` and `JWT_REFRESH_EXPIRY`. Identity lookups try the configured salt version and version 1; new records store the configured version. Retain the identity pepper when changing the salt version.

When `SUPABASE_JWT_SECRET` is configured, registered users may authenticate with Supabase HS256 tokens alongside local RSA/HS256 tokens. The JWT subject must identify an existing backend user. Supabase email, phone, and matching `user_metadata.role` claims are mapped; the current database role controls authorization because user metadata is editable. This adds JWT compatibility; the local document/contact login still does not perform external OTP or KYC verification.

Protected HTTP routes use:

```http
Authorization: Bearer <access-token>
```

All mutation routes wired through the idempotency interceptor require a key of at least 16 characters:

```http
Idempotency-Key: <unique-request-key>
```

Successful responses are cached for 24 hours per authenticated user, HTTP method, full URL including query string, and key. Public requests fall back to the device-signature header, then the caller IP. Fingerprints sort JSON object keys recursively and preserve array order. Reusing a key in the same scope with a different body returns `409 Conflict`; a replay with the same body returns the cached response and `X-Cache-Lookup: IDEMPOTENT_HIT`. Concurrent duplicates receive `409 Conflict`; lock release atomically verifies the invocation's owner token.

Login and refresh still require idempotency keys and acquire request locks, but always execute credential/account checks rather than replaying cached token responses. Outreach checks scout visibility before cache lookup, including repeated requests after an athlete opts out.

`GET /users/profile` initializes an incomplete passport if necessary. Its birth date, gender, and primary sport remain `null` until supplied; `isProfileComplete` reports completion, and drafts default to scout visibility off. Apply the follow-up `20261105010000_allow_incomplete_passports` migration with `pnpm prisma:deploy`. The original Phase 1 baseline is unchanged. Tournament and pool entry require a completed passport and a verified identity.

`POST /users/profile` and `PATCH /users/profile` upsert only the authenticated user's metadata and sport roles. Both accept camelCase and snake_case profile fields, including `sportRecords`/`sport_records`. Latitude and longitude are bounded to ±90 and ±180. Athlete writes cannot set verified metrics, earned badges, GTI, or match counters; existing scores and counters survive profile updates.

`GET /users/:id/dossier` returns the flattened dossier with the latest 20 GTI entries, 10 drill summaries, bounded safety summaries, and sport records. Athletes may read their own dossier; scouts, organizers, and federation/super admins may read others. Scout opt-out also applies to legacy passport reads and outreach. `POST /scouts/dossiers/:athleteId/outreach` upserts the current scout's notes with `outreachType: "TRIAL" | "SCHOLARSHIP"` (default `TRIAL`).

### Example registration

```bash
curl --request POST 'http://localhost:3000/api/v1/auth/register' \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: register-athlete-0001' \
  --data '{
    "email": "athlete@example.com",
    "governmentId": {
      "idType": "AADHAAR",
      "idNumber": "0000 0000 0000"
    },
    "profile": {
      "dateOfBirth": "2005-06-15",
      "gender": "FEMALE",
      "primarySport": "CRICKET",
      "district": "Ghaziabad",
      "state": "Uttar Pradesh",
      "tierClassification": "TIER_2"
    }
  }'
```

The global validation pipe rejects unknown request fields. Successful controller responses normally use `{ "success": true, "data": ..., "timestamp": ... }`; errors use `application/problem+json` with RFC 7807-style fields.

## API overview

All routes below are under `/api/v1`.

| Method and route                                                          | Access                                                   | Purpose                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /health`                                                            | Public                                                   | Check database and Redis readiness                                      |
| `POST /auth/register`                                                     | Public + idempotency key                                 | Register an athlete or recover the matching permanent profile            |
| `POST /auth/login`                                                        | Public + idempotency key                                 | Authenticate with verified contact and government ID                     |
| `POST /auth/verify-government-id`                                         | JWT + idempotency key                                    | Bind a government ID to the current user                                 |
| `POST /auth/verify-gov-id`                                                | JWT + idempotency key                                    | Alias supporting idType/idNumber, id_type/id_number, or gov_id            |
| `POST /auth/refresh`                                                      | Public + idempotency key                                 | Rotate a refresh token                                                   |
| `GET /auth/me`                                                            | JWT                                                      | Return the current JWT identity                                          |
| `GET /users/profile`                                                     | JWT                                                      | Return or initialize the authenticated user's passport                   |
| `POST /users/profile`                                                    | JWT + idempotency key                                    | Upsert the authenticated user's passport and sport roles                  |
| `PATCH /users/profile`                                                   | JWT + idempotency key                                    | Patch the authenticated user's passport                                  |
| `GET /users/:id/dossier`                                                  | Owner, scout, organizer, federation admin, or super admin | Return bounded scout dossier summaries                                  |
| `GET /users/:id`                                                          | Owner or super admin                                     | Return user/contact data                                                 |
| `PATCH /users/:id`                                                        | Owner or super admin + idempotency key                   | Update contact data                                                      |
| `DELETE /users/:id`                                                       | Owner or super admin + idempotency key                   | Deactivate an account                                                    |
| `GET /passport/:userId`                                                   | Owner, scout, federation admin, or super admin           | Return an athlete passport                                               |
| `POST /passport/:userId`                                                  | Owner or super admin + idempotency key                   | Create an athlete passport                                               |
| `PATCH /passport/:userId`                                                 | Owner or super admin + idempotency key                   | Update passport metadata                                                 |
| `POST /passport/:userId/sports`                                           | Owner or super admin + idempotency key                   | Add or update a sport record                                             |
| `GET /passport/:userId/sports`                                            | Owner, scout, federation admin, or super admin           | List sport records with `limit` and `cursor_id`; respect scout opt-out   |
| `GET /tournaments/nearby`                                                 | Public                                                   | Find open tournaments by `lat`, `lng`, and `radius_km`                   |
| `GET /tournaments`                                                       | Public                                                   | List by sport, status, organizer_id, cursor_id, and limit                 |
| `GET /tournaments/:id`                                                    | Public                                                   | Return tournament details and brackets                                   |
| `POST /tournaments`                                                       | Organizer/admin + idempotency key                        | Create an open tournament                                                |
| `PATCH /tournaments/:id`                                                  | Owning organizer or federation/super admin + idempotency key | Update tournament metadata and registration dates                    |
| `DELETE /tournaments/:id`                                                 | Owning organizer or federation/super admin + idempotency key | Delete a tournament                                                   |
| `GET /tournaments/:tournamentId/brackets`                                 | Public                                                   | List brackets with cursor pagination                                     |
| `POST /tournaments/:tournamentId/brackets`                                | Organizer/admin + idempotency key                        | Create a bracket                                                         |
| `PATCH /tournaments/:tournamentId/brackets/:bracketId`                     | Owning organizer or federation/super admin + idempotency key | Update a bracket                                                      |
| `DELETE /tournaments/:tournamentId/brackets/:bracketId`                    | Owning organizer or federation/super admin + idempotency key | Delete a bracket                                                      |
| `POST /tournaments/:tournamentId/brackets/:bracketId/register`            | JWT + idempotency key                                    | Register after GTI anti-sandbagging checks                               |
| `POST /tournaments/:tournamentId/brackets/:bracketId/free-agents/join`    | JWT + idempotency key                                    | Join the role-balanced pool                                              |
| `DELETE /tournaments/:tournamentId/brackets/:bracketId/free-agents/leave` | JWT + idempotency key                                    | Leave a queued pool entry                                                |
| `GET /tournaments/:tournamentId/brackets/:bracketId/free-agents/status`   | JWT                                                      | Return queue position or formed roster                                   |
| `POST /drills/submit`                                                     | JWT + drill HMAC + idempotency key                       | Store derived drill metrics and enqueue GTI recalculation                |
| `POST /safety/telemetry-webhook`                                          | Device HMAC + idempotency key                            | Evaluate wearable telemetry                                              |
| `POST /gti/recalculate/:athleteId`                                        | Athlete self or federation/super admin + idempotency key | Recalculate GTI                                                          |
| `GET /gti/rank/:sport/:athleteId`                                         | Public                                                   | Return global or district leaderboard rank                               |
| `GET /scouts/feed`                                                        | Scout/federation/super admin                             | Return cursor-paginated prospects                                        |
| `GET /scouts/alerts`                                                      | Scout/federation/super admin                             | Return up to 50 recent alerts                                            |
| `PATCH /scouts/alerts/:id/acknowledge`                                    | Scout/federation/super admin + idempotency key           | Acknowledge an alert                                                     |
| `POST /scouts/dossiers/:athleteId/outreach`                               | Scout/federation/super admin + idempotency key           | Create or update trial/scholarship outreach notes                        |
| `GET /heatmaps/regional`                                                  | Public                                                   | Return district density, average GTI, female participation, and centroid |

Use Swagger for the authoritative request and response schemas.

## Signed ingestion

### Drill submissions

`POST /drills/submit` requires a JWT, `Idempotency-Key`, and a lowercase or uppercase 64-character hexadecimal `X-Drill-Signature`. The HMAC-SHA256 input is:

```text
<authenticated-user-id>:<drill_type>:<form_score>:<timestamp>
```

Sign with `DRILL_HMAC_SECRET`. The timestamp may be Unix seconds or milliseconds and must be within 300 seconds of server time. If `athlete_id` is supplied, it must equal the authenticated user's ID.

### Safety telemetry

`POST /safety/telemetry-webhook` requires `Idempotency-Key` and a hexadecimal `X-Device-Signature` containing the HMAC-SHA256 of the JSON request body, signed with `TELEMETRY_SERVICE_HMAC_SECRET`. The body timestamp is required at runtime and must be within 300 seconds of server time.

Telemetry levels are evaluated as follows:

| Severity | Condition                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------ |
| Critical | Heart rate `> 195`, SpO2 `< 90`, or skin temperature `> 39.5`                                    |
| Warning  | Heart rate `> 185`, SpO2 `< 93`, or skin temperature `> 38.5`, when no critical condition exists |
| Normal   | No threshold is breached                                                                         |

Critical telemetry creates a `HealthAlert` with `matchPaused = true`. When a valid active `match_id` is supplied, the match moves to `PAUSED_SAFETY`; the service then broadcasts `MATCH_PAUSE_ALERT`.

## GTI and talent discovery

The composite Grassroots Talent Index is clamped to the range 0–100:

```text
GTI = 0.35 × biomechanical score
    + 0.25 × wearable/training consistency score
    + 0.40 × verified match-performance score
```

Recalculation persists GTI history and updates global and district Redis sorted sets. An unacknowledged scout alert is created when an athlete reaches GTI 85 or higher and is rural, underrepresented, or classified as `RURAL`, `TIER_3`, or `TIER_2`.

## Realtime events

Socket.IO clients authenticate using `auth.token` or an `Authorization: Bearer <token>` handshake header.

| Namespace         | Client subscriptions                            | Server events                                            |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `/ws/matchmaking` | `join:user`, `join:bracket`                     | `ROSTER_FORMED`                                          |
| `/ws/events`      | `join:match`, `join:athlete`, `join:tournament` | `MATCH_PAUSE_ALERT`, `GTI_UPDATED`, `SCOUT_TALENT_ALERT` |

Redis backs the Socket.IO adapter so events can fan out across application instances.

## Tournament and matchmaking rules

Tournament/bracket create and patch bodies accept camelCase and snake_case fields. GTI bounds must satisfy `0 <= minGti <= maxGti <= 100`; fees and prize pools cannot be negative. Capacity must be at least two, and team size must be between one and thirty. Registration deadlines, starts, and ends must be valid ISO dates in that order. Partial updates validate the combined persisted and supplied values. Tournament/bracket mutations check the parent tournament owner inside their serializable transaction; federation and super admins can manage other organizers' events.

Bracket registration and pool joins read current profile GTI, verified identity, bracket bounds, tournament status, and registration deadline inside the same serializable transaction as their writes. Serialization retries repeat those checks. Both above-ceiling responses contain `suggestedBracketId` and `suggestedBracketTier`, or null when no bracket contains the score. Team registration additionally checks tournament membership, captain authority, complete verified rosters, and current roster mean GTI.

Pool leave uses a conditional QUEUED-to-CANCELLED update, so a worker claim cannot be overwritten. Matchmaking reads the complete eligible queue in batches, searches primary/secondary-role assignments and alternative rosters within the mean-GTI bounds, and prevents duplicate athletes. Each formed team stores its captain and emits one roster event after commit. One job continues forming teams until no valid roster or capacity remains. Exact GTI-constrained roster search can take more work for large or difficult pools; it has no arbitrary candidate-prefix or search-attempt cutoff.

Nearby results remain a flat array ordered by unrounded distance, then UUID. Pass the last returned UUID as `cursor` with the same search coordinates, radius, and sport; an invalid or out-of-search cursor returns 400. PostGIS computes the cursor distance before applying this ordering. The Haversine fallback scans SQL bounding-box pages (including antimeridian and pole handling), calculates distances, and retains only the nearest requested results in memory. Its spherical distances are approximate compared with PostGIS geography distances.

## Quality checks

```bash
pnpm exec prisma validate
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

The migration suite executes the committed migration chain in embedded Postgres/PostGIS (PGlite), including geometry triggers, foreign keys, spatial indexes, and the production discovery/heatmap queries. Auth/passport HTTP tests use real controllers, validation, guards, JWT signature verification, and services with in-memory database/cache doubles. Health HTTP tests inject dependency failures. These checks do not establish native PostgreSQL/Redis connectivity, a live Supabase session, or full application startup; verify those against the deployment services.

## License

Private and unlicensed. See `package.json`.
