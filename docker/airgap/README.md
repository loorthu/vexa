# Vexa air-gapped deployment

Build every Vexa image on an internet-connected machine, ship a couple of tar
files to a prod server with **no internet**, and run the full stack there.

This mirrors the `build → save → load → up` pattern, adapted for a multi-service
compose stack (magboard was a single image; Vexa is ~9 images + model weights).

## What gets shipped

| Bundle | Contents |
|---|---|
| `dist/vexa-images-<tag>.tar.gz` | 7 core services, `vexa-bot`, `vexa-transcription`, and base images (`postgres`, `redis`, `minio`, `minio/mc`, `nginx`) |
| `dist/vexa-transcription-models.tar.gz` | Whisper `large-v3-turbo` weights (~1.6G) — bind-mounted, **not** baked into any image |

The image **tag** defaults to the contents of `VERSION`. Pass an explicit tag as
the first arg to any script to override.

## On the build machine (has internet)

```sh
cd ~/Documents/git/vexa
./docker/airgap/build.sh          # build all images
./docker/airgap/save.sh           # -> docker/airgap/dist/*.tar.gz
```

Copy `docker/airgap/dist/*.tar.gz` to the same path on the prod server (plus the
repo checkout itself and your `.env`).

## On the prod server (air-gapped)

Prerequisites that CANNOT be shipped in a tar — must already be installed:

- Docker + docker compose v2
- **NVIDIA GPU driver + `nvidia-container-toolkit`** (for GPU transcription)

```sh
cd ~/vexa                         # the repo checkout (from your fork)
cp /path/to/your/.env .env        # your working config with real secrets
./docker/airgap/load.sh           # docker load + unpack model weights
./docker/airgap/up.sh             # start core stack + GPU transcription
```

Stop with `./docker/airgap/down.sh` (add `--volumes` to wipe DB/storage).

## Why the extra pieces vs. magboard

- **`vexa-bot` is invisible to compose.** `runtime-api` launches it on demand
  through the Docker socket (`BROWSER_IMAGE`). `save.sh` adds it explicitly and
  `up.sh` exports `BROWSER_IMAGE=vexaai/vexa-bot:<tag>` so the running stack
  spawns the loaded image.
- **Model weights aren't in the image.** The transcription workers mount
  `./models`, so weights travel as their own tarball.
- **`--no-build` everywhere.** The upstream compose files keep their `build:`
  sections; on prod we run with `--no-build` so compose uses the loaded images
  and never tries to rebuild or pull.
- **Transcription image name is pinned** via `transcription.prod.yml` (the
  upstream workers have no `image:` field, only `build:`).

## Secrets

Nothing secret is baked into an image. All runtime config (DB passwords, admin
tokens, MinIO keys, transcription token, `VEXA_API_KEY`) comes from the repo-root
`.env` at run time. Keep that `.env` off git — carry it to prod out-of-band.

## Rebuilding after code changes

Re-run `build.sh` then `save.sh`, re-copy `dist/*`, and on prod
`load.sh` + `up.sh` again. Bump `VERSION` (or pass an explicit tag) if you want
old and new bundles to coexist.
