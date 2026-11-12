# RSA Key Rotation & Git History Purge Runbook

## Why Removing Keys in HEAD Is Not Enough

`keys/private.pem` and `keys/public.pem` were previously tracked in Git history. Deleting or untracking files in a single commit only removes them from the latest tree; every clone still carries the historical blobs via Git history. Treat the prior keypair as permanently compromised across all environments.

## 1. Rotate Live Secrets First (Zero Downtime Before History Rewrite)

1. Generate a fresh **RSA-3072** keypair locally outside any committed path (never print keys to stdout/CI logs):
   ```bash
   umask 077
   mkdir -p /tmp/kheleo-rotate && cd /tmp/kheleo-rotate
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out private.pem
   openssl pkey -in private.pem -pubout -out public.pem
   ```
2. Base64-encode both PEMs (no line wraps) and upload to Railway **Shared/Service Variables** for every environment (`staging`, `production`):
   - `JWT_PRIVATE_KEY` = single-line base64 output of `private.pem` (or raw multi-line PEM / `\n`-escaped PEM)
   - `JWT_PUBLIC_KEY` = single-line base64 output of `public.pem`
   - Do **not** set `JWT_PRIVATE_KEY_PATH` / `JWT_PUBLIC_KEY_PATH` inside Railway if using env vars (note `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` take precedence over path defaults).
3. Also rotate symmetric signing secrets if they were ever shared insecurely (`IDENTITY_PEPPER` only if no permanent government identities must remain matchable; `DRILL_HMAC_SECRET`, `TELEMETRY_SERVICE_HMAC_SECRET`, `ADMIN_INVITE_CODE` can rotate alongside frontend `.env`).
4. Securely delete `/tmp/kheleo-rotate` once injected into Railway.

## 2. Token & Session Impact Upon Key Rotation

| Artifact | Signed by RSA Key? | Impact at Rollout | Recommended Action |
| :--- | :--- | :--- | :--- |
| **Access tokens** (`JWT_ACCESS_EXPIRY=15m`) | Yes (`RS256` signed with `private.pem`, verified by `JwtStrategy` & `WsAuthGuard` with `public.pem`) | All existing access tokens immediately fail signature verification (`401 Unauthorized`). | During a rolling restart, temporarily deploy API replicas with the new keys together; clients refresh or re-authenticate cleanly. |
| **Refresh tokens** (`JWT_REFRESH_EXPIRY=7d`) | **No** — `AuthService` stores random opaque tokens as SHA-256 hashes in PostgreSQL `refresh_tokens`. | Existing valid refresh tokens remain accepted at `/api/v1/auth/refresh` and mint new `RS256` access tokens signed by the new key. | If treating old sessions as compromised (e.g., if attackers could have forged an access token prior to rotation, or forcing clean re-login), optionally run `UPDATE refresh_tokens SET revoked = true WHERE revoked = false;` immediately after rollout. |
| **WebSocket connections** (Socket.IO) | Checked during handshake (`WsAuthGuard`) | Existing connected sockets stay open until disconnect/reconnect; reconnects use new JWTs. | Restart API replicas during deploy so all clients reconnect with new access tokens. |
| **Supabase OTP contact proofs** | No (`HS256` verified via Supabase secret/endpoint) | Unaffected. | — |

## 3. Purge Old Keys From Git History (Coordinate With All 3 Developers)

Because rewriting commits changes all commit SHAs, coordinate all **3 developers** cleanly:

1. **Freeze pushes & merge/save WIP:** All 3 developers push or patch-backup local uncommitted changes (`git format-patch` or stash/branch) and stop committing until cleanup completes.
2. **Create a mirror backup before rewriting:**
   ```bash
   git clone --mirror <REMOTE_URL> kheleo-core-backend-backup.git
   ```
3. **Strip historical key blobs using `git-filter-repo` (preferred) or BFG:**
   ```bash
   brew install git-filter-repo
   git clone --mirror <REMOTE_URL> kheleo-core-backend-clean.git
   cd kheleo-core-backend-clean.git
   git filter-repo --path keys/private.pem --path keys/public.pem --invert-paths --force
   ```
4. **Verify no key blobs remain in history:**
   ```bash
   git log --all --full-history -- keys/private.pem keys/public.pem
   ```
   Output must be completely empty.
5. **Force-push all refs cleanly:**
   - Temporarily allow force-push on protected branches on GitHub, then push:
   ```bash
   git push --force --all
   git push --force --tags
   ```
   - Re-enable branch protection on `main`.
   - Ask GitHub Support / delete cached PR refs (`refs/pull/*`) and forks that still reference old SHAs.
6. **Re-sync all 3 developers (DO NOT `git pull` onto stale clones!):**
   - Each developer deletes (or archives) their old local clone and performs a **fresh `git clone`**, then regenerates a local untracked RSA-3072 dev keypair:
     ```bash
     mkdir -p keys && chmod 700 keys
     openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out keys/private.pem
     openssl pkey -in keys/private.pem -pubout -out keys/public.pem
     chmod 600 keys/private.pem
     ```
   - Never cherry-pick commits directly from an old unpurged clone without verifying `keys/` is absent.

