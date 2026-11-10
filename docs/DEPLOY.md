# Deploying Research Hub

One small server runs the whole product: the web app, the API, the background jobs (reading, transcription) and the database (a single SQLite file). Everything you must keep lives in one folder, `/data`.

## What you need
- A Linux machine you control (a VM or an internal server): 2 CPU, 4 GB RAM, 30 GB disk is a sensible start. Video and audio processing uses CPU while it runs.
- Docker with Compose (recommended), **or** Bun 1.4+ and ffmpeg installed directly.
- A Gemini API key (aistudio.google.com). A paid key is strongly preferred for real data: see `docs/SECURITY.md`.
- For https: a domain name pointing at the machine, and ports 80 and 443 open. Without https, keep it on a trusted internal network and set `COOKIE_SECURE=0`.

## First deployment (Docker)
```bash
git clone <your repo> research-hub && cd research-hub
cp .env.example .env
nano .env        # fill in GEMINI_API_KEY, ALLOWED_EMAIL_DOMAINS, ADMIN_SETUP_CODE, BACKUP_PASSPHRASE, DOMAIN
```
```bash
docker compose --profile https up -d --build     # app + automatic https for DOMAIN
# or, app only on http://127.0.0.1:8787 (put your own proxy in front):
docker compose up -d --build
```
1. Open the address **yourself, straight away**, and create the first account with your setup code. It becomes the admin.
2. Check the logs for warnings: `docker compose logs app | head -20`. Every warning is plain language. Fix each one or decide to accept it.
3. Load your research on the **Research data** screen.
4. Set up backups (below) and **do a test restore** before you rely on them.

## Without Docker
```bash
cd server && bun install --production && cd ..
bun install && bun run build            # builds dist/client
cp .env.example .env                    # fill it in, then export it or use a process manager that loads it
NODE_ENV=production DATA_DIR=/srv/research-hub/data HOST=127.0.0.1 bun server/index.ts
```
Run it under systemd (or similar) so it restarts on failure, and put nginx or Caddy in front for https.

## Settings
See `.env.example` (every setting is explained there) and `docs/AUTH.md`. The ones that matter most:

| Setting | Why it matters |
|---|---|
| `ALLOWED_EMAIL_DOMAINS` | Without it, anyone who can reach the address can create an account and read the research. |
| `ADMIN_SETUP_CODE` | Stops a stranger becoming admin if they reach a new deployment first. |
| `COOKIE_SECURE=1` + https | Keeps sign-in cookies from travelling in the clear. |
| `TRUST_PROXY=1` | Needed behind a proxy so sign-in throttling sees real client addresses. |
| `BACKUP_PASSPHRASE` | Encrypts backups (they contain password hashes and the list of removed names). |

## Backups and restore
A backup is one file containing the database, the list of removed names and the stored design images, taken while the app is running.
```bash
docker compose exec -T app bun server/cli.ts backup                  # writes /data/backups/rh-backup-<time>.tar.gz.enc
docker compose exec -T app bun server/cli.ts verify-backup /data/backups/<file>
```
- **Schedule it** (host cron): `0 2 * * * cd /opt/research-hub && docker compose exec -T app bun server/cli.ts backup`
- **Copy it off the machine** (another server, object storage). A backup on the same disk is not a backup. `docker compose cp app:/data/backups/. /somewhere/safe/`
- **Restore** (stop the app first): `docker compose stop app`, then `docker compose run --rm app bun server/cli.ts restore /data/backups/<file> --force`, then `docker compose start app`. The previous database is kept beside the restored one.
- **Test a restore** on a spare machine every quarter, and after any change to how backups are made. `verify-backup` checks integrity and counts without touching live data.

## Everyday operations
| Task | Command |
|---|---|
| Logs | `docker compose logs -f app` |
| Health | `curl -s http://127.0.0.1:8787/api/health` |
| Update | `git pull && docker compose up -d --build` (data and sign-ins are kept; unfinished jobs resume) |
| Admin forgot password (and nobody else is admin) | `docker compose exec app bun server/cli.ts reset-password someone@company.com` (prints a temporary password) |
| Promote someone to admin | `docker compose exec app bun server/cli.ts make-admin someone@company.com` |
| Rotate the Gemini key | edit `.env`, then `docker compose up -d` (restarts the app) |

## What has and has not been verified
Verified by automated tests and by running it: the production build served under the strict security policy in a real browser, sign-in, per-user data, rate limits, backups and restores (including encrypted and damaged backups), the migration of an older database, a clean-folder install using only the server's own dependency list, and uploads of spreadsheets and PDFs from that install.

**Not verified (no Docker or real server was available while this was built):**
- Building the Docker image and running the compose file. The Dockerfile follows the steps verified above, but treat the first build as a test.
- https through Caddy, and the real client address behind a proxy.
- Behaviour with many people using it at once, and very large recordings. It is a single process with a single database file: fine for a team, not sized for hundreds of simultaneous users.
- Running on a different operating system or architecture from Linux x86-64.
