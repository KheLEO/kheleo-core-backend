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
- pnpm
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

4. Generate Prisma Client and initialize the development database from the current schema.

   ```bash
   pnpm prisma:generate
   pnpm exec prisma db push
   ```

   The repository currently contains the Prisma schema but no committed migration history. Use `pnpm exec prisma migrate dev --name <migration_name>` when creating a migration that should be reviewed and committed. `pnpm prisma:deploy` applies committed migrations in deployment environments.

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
| `JWT_ACCESS_EXPIRY`             | Documented access-token duration                          | `15m`                                            |
| `JWT_REFRESH_EXPIRY`            | Documented refresh-token duration                         | `7d`                                             |
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
| `pnpm test`            | Run the five project integration/spec suites |

Run `pnpm build` before `pnpm start:prod`.

## Authentication and request integrity

Authentication is intentionally passwordless in this service. Public athlete registration accepts a phone number or email and may bind a government ID. Login requires the same verified contact plus the government-ID proof. The normalized ID is hashed with a versioned domain salt and `IDENTITY_PEPPER`; only the hash is stored.

If registration supplies a government ID already attached to the same contact, the existing permanent profile is reactivated and returned. A matching ID with a different contact is rejected to prevent account resets that would discard historical GTI data. Public registration can create only `ATHLETE` accounts.

Protected HTTP routes use:

```http
Authorization: Bearer <access-token>
```

All mutation routes wired through the idempotency interceptor require a key of at least 16 characters:

```http
Idempotency-Key: <unique-request-key>
```

Successful responses are cached for 24 hours by HTTP method, route, key, and request fingerprint. Reusing a key with a different body returns `409 Conflict`; a replay with the same body returns the cached response and `X-Cache-Lookup: IDEMPOTENT_HIT`.

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
| `POST /auth/register`                                                     | Public + idempotency key                                 | Register an athlete or recover the matching permanent profile            |
| `POST /auth/login`                                                        | Public + idempotency key                                 | Authenticate with verified contact and government ID                     |
| `POST /auth/verify-government-id`                                         | JWT + idempotency key                                    | Bind a government ID to the current user                                 |
| `POST /auth/refresh`                                                      | Public + idempotency key                                 | Rotate a refresh token                                                   |
| `GET /auth/me`                                                            | JWT                                                      | Return the current JWT identity                                          |
| `GET /users/:id`                                                          | Owner or super admin                                     | Return user/contact data                                                 |
| `PATCH /users/:id`                                                        | Owner or super admin + idempotency key                   | Update contact data                                                      |
| `DELETE /users/:id`                                                       | Owner or super admin + idempotency key                   | Deactivate an account                                                    |
| `GET /passport/:userId`                                                   | Owner, scout, federation admin, or super admin           | Return an athlete passport                                               |
| `POST /passport/:userId`                                                  | Owner or super admin + idempotency key                   | Create an athlete passport                                               |
| `PATCH /passport/:userId`                                                 | Owner or super admin + idempotency key                   | Update passport metadata                                                 |
| `POST /passport/:userId/sports`                                           | Owner or super admin + idempotency key                   | Add or update a sport record                                             |
| `GET /passport/:userId/sports`                                            | Public                                                   | List sport records with `limit` and `cursor_id`                          |
| `GET /tournaments/nearby`                                                 | Public                                                   | Find open tournaments by `lat`, `lng`, and `radius_km`                   |
| `GET /tournaments/:id`                                                    | Public                                                   | Return tournament details and brackets                                   |
| `POST /tournaments`                                                       | Organizer/admin + idempotency key                        | Create an open tournament                                                |
| `GET /tournaments/:tournamentId/brackets`                                 | Public                                                   | List brackets with cursor pagination                                     |
| `POST /tournaments/:tournamentId/brackets`                                | Organizer/admin + idempotency key                        | Create a bracket                                                         |
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

## Quality checks

```bash
pnpm exec prisma validate
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

## License

Private and unlicensed. See `package.json`.
