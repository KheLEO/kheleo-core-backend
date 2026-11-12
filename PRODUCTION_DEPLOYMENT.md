# Production deployment: backend and all four portals

Reference topology: Node 22 (latest patched 22.x, at least 22.13), PostgreSQL 16/PostGIS, Redis 7, backend on loopback 3000, Next.js on loopback 3001, TLS ingress on `app.example.com` and `api.example.com`. Replace example hosts, credentials and paths before executing. Commands use Bash and pnpm; execute each repository's commands from its own directory. Node 24 is also verified. [Node support schedule](https://nodejs.org/en/about/previous-releases).

## 1. Provision infrastructure

Use a dedicated PostgreSQL database and private networking. Enable automatic backups/PITR and test restoration before loading permanent identities. Choose one database provider:

- **Railway:** create a service from `postgis/postgis:16-3.4`, set strong `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB=kheleo_core`, attach a persistent volume at `/var/lib/postgresql/data`, and use the private connection URL. Enable backups. A plain PostgreSQL template needs a PostGIS-capable image. [Railway PostgreSQL](https://docs.railway.com/databases/postgresql).
- **RDS:** create PostgreSQL **16**, private subnets, encrypted storage, backups/PITR and a security group accepting 5432 only from application/migration hosts. Enable PostGIS as the migration owner. Use the provider CA for verified TLS; encode credentials in the URI. [RDS extension setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Extensions.html).
- **Supabase:** use a dedicated project with PostgreSQL 16 available in the selected region, checking `SHOW server_version` before continuing. Configure `DATABASE_URL` with the Supavisor **transaction pooler on port 6543** including `?pgbouncer=true&connection_limit=15&pool_timeout=10` (sized per Railway replica so total connections stay safely under Supabase pooler/Postgres limits) and set `DIRECT_URL` to the **session pooler or direct connection on port 5432** so `prisma migrate deploy` and admin scripts bypass pgbouncer safely. The current migrations expect PostGIS in `public`. Disable the Data API or remove application schemas from its exposed schemas. If PostGIS already lives elsewhere, reconcile with a DBA; do not drop extensions with CASCADE or rewrite applied migrations. Supabase Auth can remain enabled separately. [Prisma connections](https://supabase.com/docs/guides/database/prisma).

As the migration owner, on the dedicated database:

```sql
SHOW server_version;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
SELECT postgis_full_version();
```

Provision Redis **7** using a persistent service/volume, private ingress, ACL credentials and TLS when crossing trust boundaries. Set `appendonly yes`, `appendfsync everysec`, and `maxmemory-policy noeviction`; enable backups and monitor memory. Backend queues/pubsub need native TCP Redis, not a REST API. Use database 0 for backend and database 1 for frontend sessions; providers restricted to database 0 require separate instances. [Redis persistence](https://redis.io/docs/latest/management/persistence/), [BullMQ production guidance](https://docs.bullmq.io/guide/going-to-production).

Provide a Node 22 service host/container with egress to PostgreSQL, Redis and Supabase Auth. Expose only TLS ingress; keep ports 3000/3001 and database ports private. Size database pools and Redis capacity for the replica count. This guide uses a single backend and frontend; shared Redis is configured for additional replicas, with load-balancer affinity required if Socket.IO polling is enabled.

## 2. Configure contact verification

Create/retain one Supabase Auth project. Enable email OTP and configure a production SMTP sender, delivery limits and allowed application URL. Change the email OTP template to include `{{ .Token }}` so users can enter the code in KheLEO's verification dialog. Enable phone Auth and a real SMS provider if offering phone sign-in. Use either email or phone per initial login/registration; the UI explicitly checks this. [Email OTP](https://supabase.com/docs/reference/javascript/auth-signinwithotp), [Phone OTP](https://supabase.com/docs/guides/auth/phone-login).

Copy the project URL and publishable/legacy anon key to both services below. These public values are intended for browser use. Do not use a service-role key. The frontend obtains a short-lived contact proof; the backend checks confirmed ownership and issues its own RSA tokens. Government document authenticity still requires an independent administrative check. Keep the Auth project stable because platform accounts bind to its user UUID.

## 3. Generate and retain backend secrets

From `KheLEO-backend` on a secure deployment workstation:

```bash
corepack enable
corepack prepare pnpm@10.32.0 --activate
umask 077
mkdir -p keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out keys/private.pem
openssl pkey -in keys/private.pem -pubout -out keys/public.pem
chmod 600 keys/private.pem
openssl rand -hex 32 > keys/identity-pepper.hex
openssl rand -hex 32 > keys/drill-hmac.hex
openssl rand -hex 32 > keys/telemetry-hmac.hex
openssl rand -hex 32 > keys/admin-invite.hex
```

Import the generated 64-character hex values and base64-encoded RSA-3072 keys (`base64 < keys/private.pem | tr -d '\n'`) into Railway/secret manager and the env template (`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`). Retain encrypted backups of RSA keys and identity pepper; all replicas must use the identical key pair. Rotating the pepper without an identity migration breaks matching. When running Docker outside Railway, bind-mount private keys read-only with permissions readable by the application account (`node`, UID 1000) and pass `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEY_PATH`. Never copy secrets into image layers, Git, build arguments or `NEXT_PUBLIC_*` variables.

## 4. Backend environment, migrations and start

Create `/secure/backend.production.env` (mode 600); substitute real values, using URL-encoded credentials:

```dotenv
NODE_ENV=production
PORT=3000
APP_NAME=kheleo-core-backend
CORS_ORIGINS=https://app.example.com
DATABASE_URL=postgresql://kheleo:ENCODED_PASSWORD@POOLER_HOST:6543/postgres?pgbouncer=true&connection_limit=15&pool_timeout=10&sslmode=require
DIRECT_URL=postgresql://kheleo:ENCODED_PASSWORD@DB_HOST:5432/postgres?schema=public&sslmode=require&connect_timeout=5
REDIS_URL=rediss://default:ENCODED_PASSWORD@REDIS_HOST:6380/0
# Prefer base64 or inline PEM env secrets on Railway (or bind-mounted JWT_*_PATH in Docker):
JWT_PRIVATE_KEY=BASE64_OR_PEM_RSA_3072_PRIVATE_KEY
JWT_PUBLIC_KEY=BASE64_OR_PEM_RSA_3072_PUBLIC_KEY
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d
ENABLE_SWAGGER=false
SUPABASE_URL=https://PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=PUBLIC_PUBLISHABLE_OR_ANON_KEY
SUPABASE_JWT_SECRET=
ADMIN_INVITE_CODE=GENERATED_ADMIN_INVITE_HEX
IDENTITY_PEPPER=GENERATED_IDENTITY_PEPPER_HEX
IDENTITY_SALT_VERSION=1
DRILL_HMAC_SECRET=GENERATED_DRILL_HMAC_HEX
DRILL_ALLOW_LEGACY_SIGNATURES=false
TELEMETRY_SERVICE_HMAC_SECRET=GENERATED_TELEMETRY_HMAC_HEX
```

`REDIS_URL` takes precedence. Alternative native Redis variables are `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_TLS=true` and `REDIS_DB=0`; omit `REDIS_URL` when using them. Use `redis://` only on an appropriately protected private connection. `SUPABASE_JWT_SECRET` is optional legacy HS256 compatibility and can stay empty. Exact HTTPS CORS origins are required. Use the provider's trusted CA where required; do not disable certificate verification.

The template is compatible with shell sourcing after substitution if values contain no unquoted shell metacharacters; otherwise have the service manager inject environment variables directly. From the backend repository:

```bash
set -a
. /secure/backend.production.env
set +a
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm exec prisma validate
pnpm exec tsc --noEmit
pnpm build
pnpm exec prisma migrate deploy
node -e "require.resolve('./dist/main.js'); require.resolve('./dist/src/main.js')"
pnpm start:prod
```

Run migrations once as a release job before rolling replicas. The committed additive migration chain includes telemetry provenance and final alert-recovery provenance. Never run `migrate dev`, `db push`, or database reset against production. Reconcile existing databases against committed migration history; take a backup first. Configure a supervisor with restart-on-failure and graceful termination. Startup must fail on missing dependencies/secrets.

Alternatively, build the backend image:

```bash
docker build --build-arg NODE_IMAGE=node:22-alpine -t kheleo-backend:production .
docker run -d --name kheleo-backend --restart unless-stopped \
  --env-file /secure/backend.production.env \
  --env JWT_PRIVATE_KEY_PATH=/run/secrets/kheleo/private.pem \
  --env JWT_PUBLIC_KEY_PATH=/run/secrets/kheleo/public.pem \
  --mount type=bind,src=/secure/kheleo/keys,dst=/run/secrets/kheleo,readonly \
  -p 127.0.0.1:3000:3000 kheleo-backend:production
curl --fail --silent --show-error http://127.0.0.1:3000/api/v1/health
```

The image runs as UID 1000 and checks health. Its entrypoint also gates startup on migrations; coordinate a single release migration job for multiple replicas. Health must return HTTP 200 with `status`, `db`, and `redis` all `ok`. Swagger UI (`/docs`) is disabled by default when `NODE_ENV=production` unless `ENABLE_SWAGGER=true` is explicitly set in a non-public operator environment.

## 5. Frontend environment, build and start

Create `/secure/frontend.production.env` (mode 600):

```dotenv
NODE_ENV=production
APP_ENV=production
APP_ORIGIN=https://app.example.com
NEST_API_URL=https://api.example.com/api/v1
SESSION_STORE=redis
REDIS_URL=rediss://default:ENCODED_PASSWORD@REDIS_HOST:6380/1
DRILL_HMAC_SECRET=SAME_BACKEND_DRILL_HMAC_HEX
TELEMETRY_SERVICE_HMAC_SECRET=SAME_BACKEND_TELEMETRY_HMAC_HEX
SAFE_EVENTS_VERIFIED=true
NEXT_PUBLIC_SOCKET_ORIGIN=https://api.example.com
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=PUBLIC_PUBLISHABLE_OR_ANON_KEY
NEXT_PUBLIC_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

`SAFE_EVENTS_VERIFIED=true` records the operator's verification; it does not disable or enable backend authorization. Old scoring/hardware/staging flags are no longer capability gates. Private matching HMAC secrets enable validated practice and labeled BLE/simulator relay submissions. Simulator readings remain explicitly labeled and do not establish hardware or clinical attestation.

Public variables are compiled into the browser bundle. Supply them during build and runtime; rebuild if changing Auth/socket/tile origins because CSP is also built from them. Use a tile service whose terms/capacity suit production traffic. From `KheLEO-web-dashboarss`:

```bash
corepack enable
corepack prepare pnpm@11.24.0 --activate
set -a
. /secure/frontend.production.env
set +a
pnpm install --frozen-lockfile
pnpm contracts:check
pnpm build
test -d public/mediapipe
test -d public/models
pnpm start
```

`pnpm build` runs `assets:sync` before Next.js compilation. Deploy the complete `public/mediapipe`, `public/models`, `.next`, package files and production dependencies together. Keep the pinned model/WASM artifacts with the matching release. Use the default start script on 3001, a service supervisor and shared Redis sessions; memory sessions are rejected in production.

## 6. TLS and Socket.IO ingress

Create DNS records for both hosts, obtain valid certificates through the hosting platform or ACME client, and redirect HTTP to HTTPS. The following belongs in Nginx's `http` context (substitute certificate locations):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 80;
    server_name app.example.com api.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name app.example.com;
    ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;
    client_max_body_size 5m;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 75s;
    }
}
server {
    listen 443 ssl;
    server_name api.example.com;
    ssl_certificate /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;
    client_max_body_size 5m;
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 75s;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://api.example.com/api/v1/health
curl --fail --output /dev/null https://app.example.com/login
```

`/socket.io/` is the transport path for both `/ws/events` and `/ws/matchmaking` namespaces; do not rewrite it to a namespace path. Upgrade headers must pass explicitly through Nginx. [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).

## 7. Provision the initial administrator and staff

Enable the temporary `ADMIN_INVITE_CODE` only for bootstrap. Use an independently checked administrator contact/document; Supabase OTP proves contact ownership, not document authenticity. The public registration form deliberately does not offer SUPER_ADMIN.

On a private operator workstation, run the following from the backend repository with its production environment already loaded. Keep generated files private and remove them when complete:

```bash
umask 077
BOOTSTRAP_DIR=$(mktemp -d)
export BOOTSTRAP_DIR
read -r -p 'Admin email: ' BOOTSTRAP_EMAIL
export BOOTSTRAP_EMAIL
node -e 'require("node:fs").writeFileSync(process.env.BOOTSTRAP_DIR+"/otp.json",JSON.stringify({email:process.env.BOOTSTRAP_EMAIL,create_user:true}))'
curl --fail --silent --show-error "$SUPABASE_URL/auth/v1/otp" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
  --data-binary "@$BOOTSTRAP_DIR/otp.json" -o "$BOOTSTRAP_DIR/sent.json"
read -r -s -p 'Email OTP: ' BOOTSTRAP_OTP; echo
export BOOTSTRAP_OTP
node -e 'require("node:fs").writeFileSync(process.env.BOOTSTRAP_DIR+"/verify.json",JSON.stringify({email:process.env.BOOTSTRAP_EMAIL,token:process.env.BOOTSTRAP_OTP,type:"email"}))'
curl --fail --silent --show-error "$SUPABASE_URL/auth/v1/verify" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
  --data-binary "@$BOOTSTRAP_DIR/verify.json" -o "$BOOTSTRAP_DIR/proof.json"
read -r -p 'Government ID type (AADHAAR/PASSPORT/VOTER_ID/DRIVING_LICENSE/BIRTH_CERTIFICATE): ' BOOTSTRAP_ID_TYPE
read -r -s -p 'Government ID number: ' BOOTSTRAP_ID_NUMBER; echo
export BOOTSTRAP_ID_TYPE BOOTSTRAP_ID_NUMBER
node <<'NODE'
const fs = require('node:fs');
const dir = process.env.BOOTSTRAP_DIR;
const proof = JSON.parse(fs.readFileSync(dir+'/proof.json','utf8'));
if (!proof.access_token) throw new Error('No confirmed-contact token');
fs.writeFileSync(dir+'/register.json',JSON.stringify({
  email:process.env.BOOTSTRAP_EMAIL, identityAccessToken:proof.access_token,
  role:'SUPER_ADMIN', adminInviteCode:process.env.ADMIN_INVITE_CODE,
  governmentId:{idType:process.env.BOOTSTRAP_ID_TYPE,idNumber:process.env.BOOTSTRAP_ID_NUMBER}
}));
NODE
curl --fail --silent --show-error https://api.example.com/api/v1/auth/register \
  -H 'Content-Type: application/json' --data-binary "@$BOOTSTRAP_DIR/register.json" \
  -o "$BOOTSTRAP_DIR/account.json"
node -e 'const fs=require("node:fs");const r=JSON.parse(fs.readFileSync(process.env.BOOTSTRAP_DIR+"/account.json","utf8"));const a=r.data??r; if(!a.user||a.user.role!=="SUPER_ADMIN")throw Error("Bootstrap failed");process.stdout.write("Provisioned administrator "+a.user.id+"\n")'
rm -rf "$BOOTSTRAP_DIR"
unset BOOTSTRAP_OTP BOOTSTRAP_ID_NUMBER BOOTSTRAP_DIR
```

Remove `ADMIN_INVITE_CODE` from the deployed service and restart after successful bootstrap. Sign in through the frontend with the same contact, OTP and government ID. As the authorized bootstrap administrator, complete the independent identity review and approve the bound identity in `/admin/verifications`. Do not create verified users through direct SQL or change role/identity flags outside audited governance.

Register ORGANIZER and SCOUT accounts through `/signup`, selecting the role and verifying the contact code. Their government identity remains pending; registration shows an approval notice. The SUPER_ADMIN reviews their documents and approves them in `/admin/verifications` (backend `PATCH /api/v1/admin/users/:id/governance`, e.g. `{"verificationStatus":"VERIFIED"}`). They can then sign in and use their role portal. Record revocation through the same governance UI; it revokes token families and disconnects sockets.

## 8. Owner acceptance and operations

Before opening traffic, complete these checks in the actual deployed environment:

1. `/api/v1/health` is 200 with database/Redis `ok`; admin monitoring reports healthy queues/PostGIS. Verify certificate renewals, backups and restore access.
2. Email (and SMS if enabled) codes arrive; login succeeds, sessions survive a frontend restart, logout revokes refresh families, and revoked/deactivated users cannot refresh or reconnect.
3. Athlete creates a passport, sees all three live GTI components, traverses nearby cursor pages, submits a calibrated drill, and sees the GTI refresh. Check self-supplied badges/verified metrics are rejected.
4. Organizer creates/edits its tournament/brackets, inspects pools/rosters and records results. Another organizer cannot edit or join private staff scopes. Verify paused matches cannot receive results before medical clearance.
5. Authorized staff receive labeled threshold alerts and can acknowledge/resume with recorded confirmations. Athletes/scouts receive no other athlete's medical payload. Test HR >195, SpO2 <90 and temperature >39.5 using clearly labeled simulator packets on an isolated acceptance event.
6. Scout checks National/State/District leaderboards, opt-in dossiers/shortlists/outreach and state-qualified heatmaps. Admin approves/revokes staff, moderates events and sees immutable security logs.
7. Anonymous/forged sockets fail on both namespaces, foreign-room joins fail, CORS rejects foreign origins, and reused mutation keys cannot replay another user's response. Confirm `/socket.io/` upgrades to 101 in browser network tools.
8. Exercise the camera and optional real BLE sensors over HTTPS on supported browsers. Validate actual device models, sports-science calibration and safety escalation with responsible staff; automated tests do not certify physical devices or clinical outcomes.

Use `node scripts/smoke-production.cjs` only against an isolated database ending `_audit` or `_test`; it deliberately writes synthetic records and is not an operator production smoke command. CI exercises it with native PostGIS/Redis and synthetic credentials, not a live Supabase account.

Monitor failed BullMQ jobs, oldest pending outbox age, provider errors, connection pools and Redis memory. Delivery retries are at least once; REST snapshots are authoritative. Monitor pending work with:

```sql
SELECT kind, count(*), min(created_at)
FROM outbox_events WHERE delivered_at IS NULL GROUP BY kind;
SELECT id, kind, attempts, available_at, last_error
FROM outbox_events WHERE delivered_at IS NULL AND attempts > 3 ORDER BY created_at;
```

Retain the previous immutable application images and matching public assets. For rollback, stop routing new traffic, preserve backups, and roll back application images only when compatible with the migrated schema; otherwise use a reviewed forward fix or tested restore. Do not delete permanent identity records or rewrite migration history to undo a release. Keep HMAC/RSA/pepper values consistent across frontend/backend replicas and releases.

## 9. Railway dual-service API + dedicated Worker topology (Phase 2)

To scale HTTP/WebSocket traffic independently from BullMQ workers and transactional outbox dispatching without duplicating background jobs:

1. **API Service (`kheleo-core-backend-api`)**:
   - Start command: `pnpm start:prod` (resolved to `dist/main.js`)
   - Environment variables:
     - `ENABLE_EMBEDDED_WORKERS=false` (disables `OutboxDispatcher`, `GtiWorkersModule`, and `MatchmakingWorkersModule` in HTTP replicas while preserving `QueueProducerService`, REST controllers, and WebSocket gateways)
     - `RATE_LIMIT_ENABLED=true`
     - `DATABASE_URL` pointing at Supabase Supavisor transaction pool (`:6543?pgbouncer=true&connection_limit=15&pool_timeout=10`)
     - `DIRECT_URL` pointing at direct PostgreSQL (`:5432`)
     - `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` (RSA-3072 Railway secrets; never commit private keys to Git or bake them into images)

2. **Worker Service (`kheleo-core-backend-worker`)**:
   - Start command: `pnpm start:worker` (resolved to `dist/worker.js`)
   - Environment variables:
     - Same `DATABASE_URL`, `DIRECT_URL`, `REDIS_*`, `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`, `IDENTITY_PEPPER`, and HMAC secrets as the API service.
     - No public HTTP port binding required; real-time socket broadcasts (`GTI_UPDATED`, `MATCH_PAUSE_ALERT`, `SCOUT_TALENT_ALERT`, `ROSTER_FORMED`) and forced user disconnects are relayed to all connected API replicas over Redis Pub/Sub (`kheleo:ws:relay`).
     - Keep Worker replica count at `1` during initial rollout (multiple workers share `outbox_events` row locks via `FOR UPDATE SKIP LOCKED` and idempotent BullMQ `jobId`s).

3. **Build verification**:
   - `pnpm build && node -e "require.resolve('./dist/main.js'); require.resolve('./dist/src/main.js'); require.resolve('./dist/worker.js'); require.resolve('./dist/src/worker.js')"`
