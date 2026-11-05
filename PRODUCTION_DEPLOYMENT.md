# Production deployment

This deploys the backend release; owner infrastructure, Supabase contact confirmation, document approval, and dashboard contract checks must be configured. The verified application profile uses Node 24. The Dockerfile retains Node 20 Alpine as requested for compatibility, but Node 20 is end-of-life; override `NODE_IMAGE` for production. [Node release status](https://nodejs.org/en/about/previous-releases).

## 1. Secrets and runtime

Use Node 24, pnpm 10.32.0, PostgreSQL 16 with PostGIS, and Redis 7. From the repository root:

```sh
corepack enable
corepack prepare pnpm@10.32.0 --activate
umask 077
mkdir -p keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out keys/private.pem
openssl pkey -in keys/private.pem -pubout -out keys/public.pem
chmod 600 keys/private.pem
openssl rand -hex 32  # IDENTITY_PEPPER
openssl rand -hex 32  # DRILL_HMAC_SECRET
openssl rand -hex 32  # TELEMETRY_SERVICE_HMAC_SECRET
openssl rand -hex 32  # ADMIN_INVITE_CODE, only while provisioning the first admin
```

Store each generated value in the deployment secret manager. Keep the identity pepper and RSA keys stable across restarts and replicas; changing the pepper prevents matching existing ID hashes. Mount keys as read-only files. The process must be able to read the private key. Do not commit secrets or pass them as Docker build arguments.

Set these production variables (replace bracketed values):

```dotenv
NODE_ENV=production
PORT=3000
APP_NAME=kheleo-core-backend
CORS_ORIGINS=https://[dashboard-host]
DATABASE_URL=postgresql://[user]:[url-encoded-password]@[host]:5432/[database]?schema=public&connect_timeout=5&sslmode=require
REDIS_URL=rediss://[username]:[url-encoded-password]@[redis-host]:6380/0
JWT_PRIVATE_KEY_PATH=/run/secrets/kheleo/private.pem
JWT_PUBLIC_KEY_PATH=/run/secrets/kheleo/public.pem
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
SUPABASE_URL=https://[project-ref].supabase.co
SUPABASE_PUBLISHABLE_KEY=[publishable-or-legacy-anon-key]
SUPABASE_JWT_SECRET=
ADMIN_INVITE_CODE=[generated-invite]
IDENTITY_PEPPER=[generated-64-hex-value]
IDENTITY_SALT_VERSION=1
DRILL_HMAC_SECRET=[generated-64-hex-value]
DRILL_ALLOW_LEGACY_SIGNATURES=false
TELEMETRY_SERVICE_HMAC_SECRET=[generated-64-hex-value]
```

`REDIS_URL` is optional if using `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_TLS=true|false`, and `REDIS_DB=0`. A URL takes precedence. Use `rediss://` for provider TLS; certificate verification stays enabled. For a private Railway Redis endpoint without TLS, use its private `redis://` URL. Native Redis TCP is required; a REST-only endpoint cannot run BullMQ/pub/sub. Redis database 0 belongs to this backend; use a separate database or instance for dashboard sessions.

`SUPABASE_JWT_SECRET` is optional legacy HS256 direct-token compatibility. The recommended login flow verifies `identityAccessToken` at Supabase Auth and then issues this backend's RSA tokens, supporting provider signing-key changes without sharing a provider signing key with the browser. Enable actual email/SMS confirmation in Supabase. Contact confirmation does not establish government-document authenticity. New production ID bindings require administrator approval after an independent check. [Supabase authenticated user verification](https://supabase.com/docs/reference/javascript/auth-getuser).

## 2. PostgreSQL and PostGIS

Choose a **fresh dedicated backend database**. Back up an existing database and reconcile its schema/migration history before applying this baseline; never mark a migration applied merely to hide a failure.

### Railway

Provision a PostGIS-capable PostgreSQL service, for example `postgis/postgis:16-3.4`, with a persistent volume at `/var/lib/postgresql/data`. Set strong `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; use its private connection URL from the backend service. Plain PostgreSQL images do not necessarily contain PostGIS. Keep database ingress private, enable provider backups, and set connection limits appropriate for the replica count. [Railway PostgreSQL](https://docs.railway.com/databases/postgresql).

### Supabase

Create a dedicated project and copy the dashboard **Connect** direct connection or **session pooler on port 5432** URI; use direct access when the runtime supports its network address family. Do not run migrations through the transaction pooler on port 6543. [Supabase Prisma connection guidance](https://supabase.com/docs/guides/database/prisma).

The committed baseline uses unqualified PostGIS types/functions and installs PostGIS in `public`. Supabase recommends a dedicated extension schema. For this baseline's Supabase compatibility profile, disable the Data API or remove `public` from its exposed schemas; the dashboard accesses data through NestJS. Supabase Auth can remain enabled separately. The release also enables RLS and revokes browser-role access on application tables. If PostGIS is already installed in another schema, stop and reconcile that installation with a DBA; do not drop it with CASCADE or rewrite applied migration checksums. Railway's dedicated PostGIS database is the simpler reference configuration. [Supabase PostGIS schema requirements](https://supabase.com/docs/guides/database/extensions/postgis).

Run the following in the dedicated database's SQL console or through `psql` using the migration-owner connection:

```sql
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
SELECT postgis_full_version();
```

Use a private backend database role that owns the application schema/tables and can run the committed migrations. RLS denies browser/Data API roles; the trusted backend owner can access its own tables. Do not put this connection string or a Supabase service-role key in browser configuration.

## 3. Redis 7

Provision Redis 7 with persistence (AOF), a durable volume, a password/ACL account, and private ingress or TLS. Set `maxmemory-policy noeviction`: queue jobs and delivery locks must not be evicted as a cache policy. Monitor capacity, queue failures, and availability. Do not share this queue instance with unbounded application caches. For an existing Redis service, apply these settings through its provider configuration so they persist across restarts:

```text
appendonly yes
maxmemory-policy noeviction
```

Set the native connection variables from step 1. Use a service account permitted to use the commands needed by cache, BullMQ and pub/sub; an excessively narrow ACL prevents workers or the Socket.IO adapter from starting. [Railway Redis](https://docs.railway.com/databases/redis).

## 4. Build, migrate, and start

For a host deployment, make production variables available to the process, with key paths pointing to the actual mounted files. Install/build before setting a production-only dependency installation mode:

```sh
pnpm install --frozen-lockfile --prod=false
pnpm prisma:generate
pnpm exec prisma validate
pnpm exec tsc --noEmit
pnpm test
pnpm build
node audit-evidence/2026-11-05/probes.cjs
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm start:prod
```

The start command is `node dist/main.js`. `node dist/main` also resolves, and `dist/src/main.js` is a compatibility shim. Use a process supervisor with restart-on-failure and SIGTERM forwarding. API, matchmaking/GTI/scout workers, and the outbox dispatcher run in the application process; keep at least one replica continuously running.

For Docker:

```sh
docker build --build-arg NODE_IMAGE=node:24-alpine -t kheleo-backend:production .
docker run -d --name kheleo-backend --restart unless-stopped \
  --env-file /secure/path/backend.production.env \
  --mount type=bind,src=/secure/path/kheleo-keys,dst=/run/secrets/kheleo,readonly \
  -p 127.0.0.1:3000:3000 kheleo-backend:production
```

The image runs as user `node` (UID 1000); provision mounted-key ownership/group permissions for that user. Migrations run before application startup and failure prevents startup. For multi-replica releases, run one migration job first, then roll replicas; Prisma's migration lock provides additional protection, not a replacement for deployment coordination. Set the platform readiness path to `/api/v1/health`. Terminate HTTPS at the ingress, proxy `/socket.io` with WebSocket upgrades, and allow sufficient shutdown time for workers/outbox delivery to drain.

## 5. Verify the deployment

Replace the URL with the deployed backend origin:

```sh
BACKEND_ORIGIN=https://[backend-host]
curl --fail --silent --show-error "$BACKEND_ORIGIN/api/v1/health"
curl --fail --silent --show-error -o /dev/null "$BACKEND_ORIGIN/docs"
curl --fail --silent --show-error "$BACKEND_ORIGIN/docs-json" -o /tmp/kheleo-openapi.json
```

Health must be HTTP 200 with `{"status":"ok","db":"ok","redis":"ok","uptime":...}`. A 503 means a dependency is unavailable; do not route production traffic until resolved. `/docs` must return Swagger UI. Inspect logs for migration errors, missing keys, queue failures, or failed Redis authentication/TLS.

On the isolated CI/test database only, `node scripts/smoke-production.cjs` exercises the actual production entrypoint, native services, authenticated sockets, safety acknowledgement/resume, measured GTI 98.6, scout delivery, leaderboards, dashboard, and outbox drain. Its database-name safety gate prevents running its synthetic writes against an ordinary production database. This smoke test does not contact a live Supabase project or physical sensors.

## 6. Connect kheleo-web-dashboards

Set the dashboard's server/public configuration using the actual variable names from its `.env.example`:

```dotenv
APP_ENV=production
APP_ORIGIN=https://[dashboard-host]
NEST_API_URL=https://[backend-host]/api/v1
NEXT_PUBLIC_SOCKET_ORIGIN=https://[backend-host]
SESSION_STORE=redis
REDIS_URL=rediss://[dashboard-session-user]:[password]@[redis-host]:6380/1
NEXT_PUBLIC_SUPABASE_URL=https://[project-ref].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=[publishable-or-anon-key]
DRILL_HMAC_SECRET=[same-server-only-drill-secret]
TELEMETRY_SERVICE_HMAC_SECRET=[same-server-only-telemetry-secret]
SAFE_EVENTS_VERIFIED=true
SIMULATOR_INGESTION=false
STAGING_DATA_ISOLATED=false
DRILL_PRACTICE_INGESTION=false
```

The dashboard currently labels its Supabase settings as unused. **Before exposing production login, wire its confirmed Supabase session access token into `identityAccessToken` on backend register/login requests.** A document/contact-only request intentionally receives 401 in production. Use the returned backend access/refresh tokens for dashboard sessions and `auth.token` on both Socket.IO namespaces. Public environment variables must never contain the identity pepper, RSA private key, Supabase signing/service-role secret, or HMAC signer secrets.

Update the server relay's drill signer to the full/full-v2 contract in README and send `X-Drill-Signed-Fields: full`; legacy four-field signatures are disabled in the production profile. Do not sign arbitrary client-supplied claims without the relay's authentication/calibration policies. Simulator/practice ingestion remains off in production.

Create the first SUPER_ADMIN using a confirmed contact session, the temporary admin invitation, and a government identity binding. Perform an independent document check, then approve identity status through the admin API. Remove/rotate the invite after provisioning. Approve other verified identity records only through authorized administrators.

Check from the deployed dashboard: successful session creation, `/users/profile`, tournament listing, `/gti/leaderboards`, authorized admin dashboard, socket authentication, and safety room isolation. An anonymous socket must not connect to a namespace or receive medical events. A scout must not receive another athlete's medical events. Confirm browser CORS/preflight and server-relay connectivity separately. These owner-environment checks are required before declaring the dashboard connected.

## 7. Operations and rollback

Back up PostgreSQL and protect Redis persistence before releases. Monitor outbox backlog/oldest pending age and failed BullMQ jobs. Recovery is at least once: REST state is authoritative and clients must tolerate recovered notifications.

```sql
SELECT kind, count(*), min(created_at)
FROM outbox_events WHERE delivered_at IS NULL GROUP BY kind;
SELECT id, kind, attempts, available_at, last_error
FROM outbox_events WHERE delivered_at IS NULL AND attempts > 3 ORDER BY created_at;
```

Keep delivered outbox payloads only as long as operational recovery requires; they may contain sensitive safety data. Immutable security audit snapshots have separate retention/access policies. Delete only delivered outbox rows under an approved retention policy, never pending events.

For a code rollback, stop the rollout and redeploy the prior image only if compatible with the migrated schema. Keep forward migrations and fix forward when possible. For a database restore, stop writers, restore a tested backup into a fresh database, verify migration history/health, then switch connection strings. Never run `prisma migrate reset` or drop PostGIS CASCADE on production data. A restore exercise and owner-environment acceptance checks complete the operational handoff.
