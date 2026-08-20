# Working notes — local environment for the recording work

Operational knowledge that is NOT recoverable from the code or the commits. The plan
(`meeting_recording_playback.plan.md`) says what to build and why; this says how to run it on this
laptop. Phases 1–4 are done and committed; Phase 5 (the airgap collector) is next.

## The VPN breaks TLS in four different places

Each needed a different fix. This is the single biggest time sink in the setup.

| Where | Symptom | Fix |
|---|---|---|
| host npm / pnpm | `SELF_SIGNED_CERT_IN_CHAIN` | `NODE_EXTRA_CA_CERTS=<roots.pem>` |
| Node inside a Docker build | corepack cannot fetch pnpm | CA baked into the base image |
| Chromium in the bot container | "Your connection is not private" | CA in the **NSS db** (`~/.pki/nssdb`), not the system store |
| pip / uv in a Docker build | cannot reach PyPI | `PIP_CERT` + `SSL_CERT_FILE` + `UV_NATIVE_TLS` |

Export the CA bundle once per session:

```sh
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > /tmp/roots.pem
security find-certificate -a -p /Library/Keychains/System.keychain >> /tmp/roots.pem
export NODE_EXTRA_CA_CERTS=/tmp/roots.pem
```

**Chromium is the non-obvious one.** `NODE_EXTRA_CA_CERTS` fixes the build and leaves the browser
broken, and `login-status` then reports `logged_in` anyway because Chrome keeps the original URL
behind a cert interstitial — so the probe sees `myaccount.google.com` and calls it success. If the
session browser looks logged in but nothing works, check TLS inside the container first:

```sh
docker exec vexa-browser-session-1 curl -s -o /dev/null -w '%{http_code}\n' https://accounts.google.com
```

## Images: build order matters

`python:3.12-slim` is retagged locally with the CA. BuildKit resolves `FROM` from the registry, so
it must be overridden explicitly per build:

```sh
# meeting-api  (context = repo root)
docker build --build-context python:3.12-slim=docker-image://vexa-python-ca:latest \
  -f core/meetings/services/meeting-api/Dockerfile -t vexaai/v012-meeting-api:v012 .

# gateway  (context = the SERVICE dir, not the repo root — a root context fails with "/src not found")
docker build --build-context python:3.12-slim=docker-image://vexa-python-ca:latest \
  -f core/gateway/services/gateway/Dockerfile -t vexaai/v012-gateway:v012 core/gateway/services/gateway
```

**The bot needs two steps, always.** `make bot` rebuilds the join-env base and wipes the CA patch,
so build from the Dockerfile directly and re-apply the CA layer afterwards — skipping the second
step leaves the session browser unable to reach Google:

```sh
docker build -t vexa/vexa-bot:dev -f core/meetings/services/bot/Dockerfile .
docker build -t vexa/vexa-bot:dev -f <scratch>/Dockerfile.ca2 <scratch>    # re-apply CA + NSS db
```

## Running tests (no local uv/pytest/tsx)

```sh
# python — meeting-api / gateway
docker run --rm -v "$PWD":/w -w /w/core/<...> -e UV_PROJECT_ENVIRONMENT=/tmp/venv \
  vexa-python-ca:latest bash -c 'pip install -q uv==0.9.22 && uv run --project . pytest -q'

# node — pnpm is via corepack; deps need one install with the CA exported
corepack pnpm install --filter @vexa/bot... --frozen-lockfile=false
corepack pnpm --filter @vexa/recording test

# DNA backend
cd backend && docker compose -f docker-compose.yml -f docker-compose.local.yml \
  run --rm --no-deps api python -m pytest -q --no-cov
```

## Stack bring-up

`deploy/compose/.env` is seeded from `.env.example` with three overrides: `BROWSER_IMAGE=vexa/vexa-bot:dev`,
`RECORDING_ENABLED=true`, `TRANSCRIBE_ENABLED=false` (no Whisper — turn on for Phase 6 alignment).

```sh
cd deploy/compose && docker compose -p vexa-v012 -f docker-compose.yml up -d --no-build \
  postgres redis minio minio-init admin-api gateway meeting-api runtime
make -s provision-token ADMIN_TOKEN=dev-admin-token     # mints the API key
```

Skip `agent-api`, `mcp`, `terminal` — `agent-api` has no published image and none are on the
recording path. Registry pulls time out through the VPN proxy; **retry, layers resume**.

Session browser (the human-authenticated one meeting bots attach to):

```sh
VNC_HOST_PORT=6080 EMAIL=self-host@vexa.ai ADMIN_TOKEN=dev-admin-token \
  deploy/compose/bin/browser-session.sh up          # noVNC at localhost:6080
```

Inspect object storage:

```sh
docker run --rm --network vexa-v012_vexa --entrypoint sh minio/mc:latest -c \
  'mc alias set v http://minio:9000 vexa-access-key vexa-secret-key >/dev/null && mc ls -r v/vexa/recordings'
```

## DNA → Vexa wiring

`backend/docker-compose.local.yml` (gitignored) carries `VEXA_API_URL=http://gateway:8000` and joins
the external `vexa-v012_vexa` network. The network join is **required**: the gateway publishes on
`127.0.0.1:18056`, which is loopback-bound and invisible to containers, so `host.docker.internal`
does not work either.

`VEXA_API_KEY` was passed as a shell variable, so it is baked into the running container and **not
persisted**. Recreate `dna-backend` without it and every bot dispatch 400s (the provider silently
falls back to `https://api.cloud.vexa.ai` with an empty key). Put it in `docker/airgap/.env`, which
that compose file already reads.

## Live test loop

1. Dispatch: `POST /bots` with `authenticated: true, recording_enabled: true`.
2. **Verify the topology actually under test** — `docker inspect <container>` and check `cdpUrl` is
   set. Published upstream images ignore `authenticated`, so a stack running them silently tests the
   guest path instead of CDP attach. This cost a whole round of false confidence.
3. Watch parts land: poll the chunk index, or `mc ls` the session prefix.
4. The bot self-terminates ~2 min after the last human leaves, and its container is reaped.

Do not read `/master` mid-recording expecting a complete file — it is a snapshot of what existed
then. That used to freeze permanently; it now rebuilds, but the snapshot is still partial.

## Verification habits worth keeping

Three bugs this work found were invisible to unit tests and only appeared on a live run. Two more
were found by *distrusting a green test*:

- **A test that cannot fail is worse than no test.** The concurrent-chunk race test passed WITH the
  bug, because the in-memory fakes never suspend and `asyncio.gather` ran one upload to completion
  before starting the other. Verify red-before by reverting the fix.
- **Don't measure a file that is still being written.** Three drift measurements disagreed
  (−0.6%, +1.9%, +7.7%) purely because ffmpeg's on-disk lag varies. Compare a persisted anchor
  against a finished file instead.
- **`make ... | tail` hides failures** — the pipeline's exit status is `tail`'s. Two builds looked
  green when they had failed.

## Outstanding

- `gate:config-contract` is RED, pre-existing from `cb09e142`: `BROWSER_SESSION_NAME_PREFIX` and
  `BROWSER_SESSION_CDP_PORT` are read in `bot_spawn/service.py` but not declared in
  `config.v1.json`. Two lines; owner's call.
- Vexa `5160dd55` carries a sealed-contract change (`api.v1` resealed). Per AGENTS.md the seal diff
  is the review artifact and wants a human on the PR — it should not ride in on green gates.
- The **audio** media file still has `start_time_utc = None`; only video was wired. Phase 5's mux
  would otherwise assume both streams start together.
- `docker/airgap/.env` is stale vs `.env.example` (no `BACKEND_URL`, no `REVIEW_SESSIONS_URL`).
- The CA patches live only in local images. If this becomes the regular test bed, that injection
  belongs in the Dockerfiles behind a build arg, or every contributor on the VPN rediscovers it.
