# Meeting recording → per-shot embedded playback (Vexa + DNA)

## Context

During a dailies review, a Vexa bot sits in the meeting and streams transcript
segments into DNA. DNA already knows *which shot was on screen when* — every
transcript segment is stamped with the version that was in review at the moment it
arrived. What nobody can do today is **watch** that moment.

This feature closes that gap end to end:

1. The Vexa bot records the meeting to a fragmented MP4 while the session runs,
   uploading it in chunks as it goes.
2. During the session, a collector inside the airgapped network pulls those chunks
   through the DNA backend and assembles its own copy.
3. When the meeting ends, the collector verifies its copy against the backend's
   hash, writes it to a network path, records that path in DNA's database, and
   tells the backend to delete the upstream copy.
4. DNA maps each version to the wall-clock spans where it was under review and
   embeds a `<video>` — served from the network path — scrubbed to those spans.

The load-bearing insight, inherited from DNA's earlier video-segmenting work, is
that **segmentation does not need to be invented**. It already happened, live,
encoded in the timestamps on the stored transcript segments. Turning a recording
into per-shot clips is a pure replay of decisions the room already made.

## Production topology

```
AIRGAPPED PROD HOST                    │  INTERNET-SIDE HOST
                                       │
  browser                              │
    │ plays  ┌──────────────────────┐  │
    ├───────►│ nginx :8081          │  │
    │        │  /recordings/ → /net │  │   ┌─────────────┐    ┌───────┐
    │  /api/ │  /api/, /ws  ────────┼──┼──►│ DNA backend │◄───│ Vexa  │
    └───────►└──────────────────────┘  │   │   :8000     │    │:18056 │
             ┌──────────────────────┐  │   └─────────────┘    └───────┘
             │ collector (new)      │  │          ▲               ▲
             │  pulls chunks ───────┼──┼──────────┘               │
             │  writes /net/media/… │  │                     bot uploads
             │  POSTs path + hash ──┼──┼──────────┘          chunks live
             └──────────────────────┘  │
```

The browser never crosses the airgap. nginx on the prod host is the only bridge,
and today it proxies `/api/`, `/ws` and `/review-sessions/` to `${BACKEND_URL}`.
The collector is a new service on the prod host using that same link.

## Decisions

| Question | Decision |
|---|---|
| What the MP4 contains | The bot's full A/V view of the meeting |
| Capture mechanism | CDP `Page.startScreencast` → ffmpeg `image2pipe` → h264 |
| Container | **Fragmented MP4** (`+frag_keyframe+empty_moov+default_base_moof`) |
| Upload | **Chunked, during the session** (byte-split of ffmpeg's stdout) |
| Transport to airgap | **Dedicated pull endpoint**, polled by the collector |
| Assembly + custody | Airgap collector service → network path, recorded in Mongo |
| Playback | nginx serves the network path directly (native Range) |
| A/V mux | Collector muxes locally at end-of-meeting (ffmpeg on the prod host) |
| Retention / access | Trusted mount, kept indefinitely — no expiry, no auth hop |
| Shot → clip mapping | DNA's persisted session timeline (segments stamped `in_review`) |
| Clipping | Virtual cuts — offsets into one file, no rendering |
| Transcript sync | Out of scope for v1 — playback only |
| Where Vexa changes land | Fork `loorthu/vexa`, branch `bot-authentication-v2`, gate-clean |

**Branches** — both named `meeting-recording-playback`, cut from the current work:
DNA from `follow-along` (`ab6d556`), Vexa from `fork/bot-authentication-v2` (`dd9c17ff`).

### Why CDP screencast and not x11grab

Vexa ships a complete but unwired `VideoRecordingService` that does
`ffmpeg -f x11grab -i :99`. On `bot-authentication-v2` that would record a blank
desktop: this branch attaches the bot over CDP to a long-lived, shared
`vexa-browser-session-<user_id>` container, so the browser renders on *that*
container's display and the bot's own `:99` is empty. The branch already hit this
for input — `join-driver.ts` forces `uiInteractionMode: 'synthetic'` for exactly
this reason. Screencast runs over the CDP session the bot already holds, so it is
topology-independent and per-tab.

### Why fragmented MP4

Byte-splitting any stream and concatenating the parts restores it exactly, so
chunking works for any container. What fMP4 buys is that **every prefix is a
playable file**: `empty_moov` puts the movie header up front and each fragment
carries its own index. That means the collector can verify progressively, and a bot
that dies mid-meeting still leaves a playable recording rather than a corrupt one.

It also rides Vexa's existing byte-concat master builder unchanged
(`recording_codec.py` dispatches `wav` → RIFF merge, **everything else** →
`b"".join(chunks)`), so there are no codec changes and no golden-vector edits in
either language. `+faststart` is dropped — it is incompatible with `empty_moov`,
and it no longer matters once playback is a local file served by nginx.

## What already exists (do not rebuild)

**Vexa** — `VideoRecordingService` (written, exported, imported by nobody); the
whole chunk → MinIO → master pipeline with `recording.v1` semantics (`seq`,
`is_final`, empty final chunk as the completion signal); `captureModes` already
carries `["audio","video"]` from `bot_spawn/service.py:325` and **the bot's
TypeScript never reads it** — that is our flag, free of any contract change.

**DNA** — `transcription_service.py:242-256` stamps every arriving segment with
`PlaylistMetadata.in_review` → `StoredSegment{version_id, absolute_start_time,
absolute_end_time}`. **This is the session timeline.** Branch
`origin/feature/meeting-recording-segmenting-and-publishing` has a tested pure
cut-list builder (`backend/src/dna/video_segment_publish.py` + its tests) — port it.

> Follow Along is ephemeral, browser-local and never persisted. It is **not** the
> timeline source.

## Findings that shape the work

**F1 — Vexa has no per-chunk read endpoint.** `/recordings/{id}/master` and
`/media/{mfid}/raw` both serve the *assembled master* and explicitly refuse raw
parts. Streaming chunks out during the session therefore needs a **new Vexa route**
— the one genuinely expensive piece of governance in this plan (`lane:contract`,
see V2).

**F2 — `DELETE /recordings/{id}` is declared in api.v1 but waived, not
implemented.** The waiver reasons that deletion "rides `DELETE /meetings/{p}/{n}`,
which purges the meeting's recordings" — but that would take the transcripts too,
which DNA needs. Implementing it and dropping the waiver requires **no reseal**,
because the route is already in the sealed contract.

**F3 — Recording *response bodies* are not sealed.** Every `/recordings*` entry has
an empty `200` schema (`{}`), there are no recording goldens, and
`test_contract_conformance.py` checks route existence only. Adding `start_time_utc`
trips neither `gate:contract-version` nor `gate:db-schema` (recordings live in
`meetings.data['recordings'][]` JSONB).

**F4 — The airgap origin is plain HTTP, so `crypto.subtle` is undefined there.**
The prod frontend is `http://<host>:8081`, not a secure context, which also rules
out OPFS. The collector design sidesteps both: hashing happens in Python, and the
browser never stores the video.

**F5 — The existing `/ws` must not carry media.** No auth, no subscriptions, a
serial `send_text` loop over all connections with no backpressure or drop policy,
and JSON-text only on both ends. One slow client already blocks every other client's
transcripts; hundreds of MB would be fatal. This is why transport is a pull.

**F6 — nginx sets no `client_max_body_size`,** so the 1 MB default applies to every
proxied request body. Chunk *reads* are GETs and unaffected, but the collector's
metadata POST back to the backend must stay small (it will — a path and a hash).

---

# Vexa

## V1 — Chunked fMP4 capture

**V1a — ffmpeg in the bot image.** `core/meetings/services/bot/Dockerfile`, runtime
stage: add `ffmpeg` alongside `pulseaudio fluxbox socat`, mirroring
`deploy/lite/Dockerfile.lite:71-75`. This is the only thing currently stopping
`VideoRecordingService` from running at all; Playwright's bundled ffmpeg has no
libx264.

**V1b — `VideoRecordingService` becomes a screencast sink writing to a pipe.**
`@vexa/recording` must not import Playwright (`gate:isolation`, `gate:graph`), so
the bot owns the CDP session and the service exposes `pushFrame(jpeg: Buffer)`.

ffmpeg args:
```
-y -f image2pipe -vcodec mjpeg -framerate <FPS> -i -
-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -g <FPS*2>
-movflags +frag_keyframe+empty_moov+default_base_moof
-f mp4 pipe:1
```
Output goes to **stdout**, not a file. The bot reads that stream, accumulates until
a size or time threshold, and uploads each buffer as chunk `seq` — concatenation
restores the byte stream exactly.

**Frame pacing is the highest-risk detail in the whole feature.**
`Page.screencastFrame` fires on visual *change*, not at a fixed rate. Fed straight
into `-framerate 10`, ffmpeg assumes 10 fps, so a static three-minute stretch
becomes two seconds of video and the file's timeline silently decouples from wall
clock. DNA computes `video_in = segment_wall_time - recording_t0`, so any drift
corrupts every cut.

Fix with a Node-side pacer (`FramePacer`, exported from the same file — do not add a
directory, `gate:readme` requires a README per directory):
- `pushFrame` only updates `latestFrame`; it never writes.
- A timer at `1000/FPS` computes `expected = floor((now - startTime) * FPS / 1000)`
  and writes `expected - emitted` copies of `latestFrame`, capped at ~2×FPS per tick.
- Self-correcting: timer drift, GC pauses and a stalled screencast all get absorbed,
  and `emitted / FPS` always equals elapsed wall seconds.
- Emit a synthesized 1-pixel black JPEG before the first real frame so the timeline
  starts at `startTime` even if the meeting UI paints late.
- On `write()` returning `false`, skip emission until `'drain'` but **still advance
  `emitted`** — dropping frames is correct; slipping time is not.

Preferable to `-use_wallclock_as_timestamps` + vfr→cfr, which adds a second implicit
clock and cannot be unit-tested offline.

**`muxAudio` fix:** it currently picks `-c:a copy` for non-`.wav` input; we hand it a
`.webm` (Opus) file, and Opus-in-MP4 breaks in Safari/QuickTime. Use `aac` for mp4
targets.

**Env:** `VEXA_VIDEO_FPS` (default 5 — ample for screen content, halves CPU vs 10),
`VEXA_VIDEO_JPEG_QUALITY` (60), `VEXA_VIDEO_MAX_WIDTH` (1280),
`VEXA_VIDEO_CHUNK_BYTES` (default 4 MB). Precedent for unregistered bot-local env:
`VEXA_RECORDING_TIMESLICE_MS`.

**V1c — bot wiring.** In `capture-bridge.ts`, `startVideoRecording(page, inv, tee)`:
`page.context().newCDPSession(page)`, `page.bringToFront()`, subscribe to
`Page.screencastFrame` and **ack immediately on receipt** (Chromium stops after ~1
frame otherwise; acking before `pushFrame` means ffmpeg backpressure can never stall
the browser), then `Page.startScreencast({format:'jpeg', quality, maxWidth,
maxHeight, everyNthFrame:1})`.

In `pipeline.ts`, add `startVideo?: () => Promise<() => Promise<void>>` to
`LivePipelineDeps` and a `'video-start'` stage — the right seam because
`createLivePipeline.stop()` is already awaited by the orchestrator before
`join.leave()` *and* idempotently by `index.ts`'s `finally`.

In `index.ts`, the gate and the only read of `captureModes` in the TS tree:
```ts
const videoCaptureEnabled = !!inv.recordingEnabled && (inv.captureModes ?? ['audio']).includes('video');
```
The service needs `session.page`, so construct it inside the `try` after
`launchBrowser(inv)`, not beside `createBotRecordingSink()` at `index.ts:169`. Start
via `pipeline.start()`, which the orchestrator calls after admission
(`orchestrator.ts:125`) — the comment at `index.ts:177` explains why anything
earlier runs against a blank pre-navigation page.

**Wrap all of it so a video failure logs and is swallowed: it must never fail the
meeting.**

**V1d — audio tee for the mux.** PulseAudio cannot work under CDP attach (the
browser is in another container, so `parec` records silence). The page-side
MediaRecorder tap is the only source that works in both topologies — the same reason
screencast beats x11grab. In `startRecording()`, the `__vexaRecordingChunk`
exposeFunction already holds every chunk's bytes in Node; append them in seq order to
a local `.webm` and stamp `Date.now()` on the first. Concatenating MediaRecorder webm
chunks *is* a valid webm — exactly what `_build_webm_master` does server-side.

Start the video recorder **before** `startRecording` so `audioDelayMs` is reliably
≥ 0; `muxAudio` clamps negatives, which would silently mis-sync by up to one 15 s
timeslice.

> **The streamed chunks are video-only.** Audio rides the existing MediaRecorder
> tap and is uploaded separately as its own media file. The two are joined **by the
> collector**, not the bot: at end-of-meeting it pulls the finished audio master and
> muxes locally with `-c:v copy -c:a aac`. `VideoRecordingService.muxAudio()` is
> therefore **not used on this path** — it stays for the guest/local-file path.
> Consequence: ffmpeg is a dependency of the airgap collector image.

## V2 — Chunk read API  ⚠️ the one expensive governance step

Per F1 there is no way to read individual chunks today. Add:

```
GET /recordings/{recording_id}/media/{media_file_id}/chunks          → chunk index
GET /recordings/{recording_id}/media/{media_file_id}/chunks/{seq}    → chunk bytes
```

The index returns `[{seq, size_bytes, sha256, uploaded_at}]` plus `complete: bool` —
enough for the collector to poll, fetch what's new, and know when the recording is
done. Chunks are already individually addressable in object storage
(`chunk_storage_key()` → `recordings/{user}/{rec}/{session}/{media_type}/{seq:06d}.{fmt}`),
so this is a read over existing keys.

Per-chunk sha256 should be computed at **upload** time and stored in the media-file
JSONB (no migration — JSONB), so the read path never re-hashes.

**Governance:** this is a new public route, so it is a genuine `lane:contract`
change — edit `core/gateway/contracts/api.v1/api.schema.json`, run
`pnpm seal:contracts`, add the gateway proxy routes under the existing
`{"tx","bot"}` scope, and add the routes to `API_V1_MEETING_SURFACE` in
`test_contract_conformance.py`. This is the only reseal in the plan.

## V3 — Implement `DELETE /recordings/{recording_id}`

Per F2 the route is already in api.v1 and merely waived. Implement it against the
JSONB record (drop the entry, delete the chunk and master objects from MinIO), add
the gateway proxy route, and **remove the waiver** — the conformance test
specifically fails on a stale waiver for a now-implemented route. **No reseal**, as
the route is already sealed.

## V4 — MP4 awareness + wall-clock anchor

In `core/meetings/services/meeting-api/src/meeting_api/recordings/`:

1. `service.py:27` — add `"mp4": "video/mp4"` to `_CONTENT_TYPES`.
2. `router.py` (~283) — content type is hardcoded
   `"audio/webm" if type == "audio" else "video/webm"`; derive it from the media
   file's `format`.
3. `jsonb.py:78-83` — `master_finalized` hardcodes `master.webm`/`master.wav`;
   generalize to `…startswith("master.")` so `/video/master.mp4` is recognized.
4. **Persist `start_time_utc`.** `video-recording.ts:146` already sends it; the
   server drops it (`jsonb.py:110` whitelists metadata to `sample_rate`). Thread it
   through `router.internal_upload_recording` → `service.upload_chunk` →
   `jsonb.apply_chunk_to_recording`, first-write-wins like `first_chunk_at`, and
   surface it on `get_recording_master`.

This is the anchor DNA's entire cut mapping keys off. Server-side `first_chunk_at`
is only an approximation of it.

## V5 — Gateway response headers (recommended, no longer blocking)

`app.py:289` returns `Response(content=resp.content, status_code=…, media_type=…)`,
dropping `Content-Range` and `Accept-Ranges`. In the airgap design nothing Range-seeks
through the gateway any more — the collector fetches whole chunks, and playback is
nginx serving a local file — so this is **no longer a blocker**. It still matters for
the non-airgap deployment and for local dev, and it is a five-line fix with an easy
red-first test. Do it, but it no longer gates anything.

## V6 — Gate checklist

| Gate | Status |
|---|---|
| `gate:python` | V2, V3, V4, V5 |
| `gate:node` | V1b–V1d |
| `gate:contract-version` + `pnpm seal:contracts` + `lane:contract` | **V2 only** |
| `gate:contract-conformance` | V2 (add routes), V3 (remove waiver) |
| `gate:graph` / `gate:isolation` | keep Playwright out of `@vexa/recording` |
| `gate:db-schema` | not tripped (JSONB) |
| `gate:dataflow` / `seal:arch` | not tripped — no new module dir |
| recording goldens | **not tripped** — do not touch either `recording_codec` twin |
| `gate:licenses` | zero new deps; ffmpeg is apt |
| `gate:readme` | only if you add a directory — don't |

`node scripts/gates.mjs all` before every push. **No agent co-author trailers**
(AGENTS.md D13) — this conflicts with the default commit trailer.

---

# DNA backend

## D1 — Provider methods

Per `always-use-providers`, all Vexa access goes through
`transcription_providers/`. Add to the base (raising) and `vexa.py`:
`list_recordings(vexa_meeting_id)`, `get_recording(id)`,
`get_recording_master(id, media_type)`, `list_recording_chunks(id, mfid, after_seq)`,
`get_recording_chunk(id, mfid, seq)`, `delete_recording(id)`.

`GET /recordings` is API-key-scoped and returns *all* the caller's recordings —
filter by `meeting_id` client-side.

## D2 — Chunk pass-through for the collector

```
GET  /api/recordings/{playlist_id}/chunks?after=<seq>   → index + complete flag
GET  /api/recordings/{playlist_id}/chunks/{seq}         → chunk bytes
POST /api/recordings/{playlist_id}/archived             → {network_path, sha256}
DELETE /api/recordings/{playlist_id}                    → purge upstream
```

Playlist-addressed rather than recording-addressed, so the collector never needs to
know Vexa ids. **A pure pass-through — the DNA backend stores no copy**, which keeps
the number of copies at two (Vexa + collector) and then one after the delete.

`POST .../archived` writes `recording_network_path` and `recording_sha256` into
`PlaylistMetadata`, and is the collector's signal that its copy is durable. Only
after that does `DELETE` succeed — refuse the delete if no archive is recorded, so a
bug in the collector cannot destroy the only copy.

Logic in `backend/src/dna/recording_media.py`, **not** `main.py`: `pytest.ini` sets
`--cov=dna`, so `main.py` is not coverage-measured and the ≥90% bar would silently
not apply.

## D3 — Link playlist → recording

Add to `PlaylistMetadata` (+ `PlaylistMetadataUpdate`): `vexa_recording_id`,
`recording_media_file_id`, `recording_start_time_utc`, `recording_duration_seconds`,
`recording_network_path`, `recording_sha256`, and `transcription_ended_at` (ported
from the prior-art branch).

Resolve the recording id **lazily** on first chunk-index request, and *also* eagerly
in `transcription_service.on_transcription_completed` (line 318, wrapped in
try/except like the surrounding code). The lazy path is the one that actually works
— the bot is often still uploading when `transcription.completed` fires.

## D4 — Port the cut-list builder

Cherry-pick `backend/src/dna/video_segment_publish.py` and
`backend/tests/test_video_segment_publish.py` from
`origin/feature/meeting-recording-segmenting-and-publishing`. Keep the module name so
the branches converge and the ShotGrid publish path can consume the identical
`VersionCutList` later — that is the "render later" seam. Leave `video_render.py`
behind.

Add `recording_t0_from_vexa(start_time_utc)` — strictly better than both existing
heuristics, being the bot's own clock at ffmpeg start, the same clock the pacer uses
to define frame 0. Keep the Zoom-folder and meeting-end helpers as fallbacks, and add
a `resolve_recording_t0()` returning `(t0, source)` so the API reports *which* anchor
it used.

Add `get_segments_for_playlist(playlist_id)` to the storage provider; the existing
compound index makes it an index-prefix scan.

## D5 — Cut-list endpoint

`GET /recordings/cuts/{playlist_id}` → `media_url` (the nginx path, or null),
`duration_seconds`, `recording_t0`, `recording_t0_source`, `versions[]` of
`{version_id, cuts[], body_hash}`, and an explicit
`status: "ready" | "archiving" | "no_recording" | "no_segments" | "pending"`.

That status enum is what lets the UI distinguish "no recording exists" from "this
version was never discussed" from "the collector is still assembling" — otherwise all
render as a blank box. Logic in `dna/recording_cuts_service.py`; flag-gated by
`DNA_ENABLE_RECORDING_PLAYBACK`.

---

# The collector (new service, airgap side)

`docker/airgap/collector/` — a small Python service beside nginx on the prod host,
added to `docker-compose.frontend.yml`.

**Loop.** Poll `GET /api/recordings/{playlist_id}/chunks?after=<last_seq>` every
~10 s for playlists with an active meeting (discovered via the existing playlist
metadata). Fetch each new chunk, verify its sha256 against the index, append to
`<staging>/<playlist_id>.mp4`, record progress in a small local state file so a
restart resumes rather than restarting.

**On `complete: true`:** finish the file, optionally fetch and mux the audio master
(see the V1d tension), compute the whole-file sha256, move it to
`RECORDING_NETWORK_PATH/<show>/<playlist_id>-<recording_id>.mp4`, `POST .../archived`
with the path and hash, then `DELETE /api/recordings/{playlist_id}`.

**Why a service and not the browser:** a browser cannot write to a network
filesystem; `crypto.subtle` is unavailable on the plain-HTTP prod origin (F4); a
page reload would lose ~400 MB of accumulated state; and nothing would resume. The
collector has none of those problems and makes hashing a two-line Python call.

**Ordering guarantee.** Never delete upstream until `archived` is recorded *and* the
file is readable at the network path with a matching hash. The delete endpoint
enforces this server-side too (D2), so the rule holds even if the collector is buggy.

**nginx.** Add a location serving the recordings root:
```nginx
location ^~ /recordings/ { alias /net/media/dna-recordings/; }
```
Native Range support, no proxy hop, no auth ticket, and seeking is free. Also set
`client_max_body_size` explicitly (F6) — the default 1 MB is fine for the metadata
POST but should be deliberate rather than accidental.

---

# DNA frontend

## D6 — Core types + hook

`interfaces.ts`: `RecordingCut`, `VersionCuts`, `PlaylistRecordingCuts` (snake_case
preserved, matching the `StoredSegment` mirror at line 314). `apiHandler.ts`:
`getRecordingCuts(playlistId)`. `hooks/useRecordingCuts.ts`: TanStack Query keyed on
playlist id, with `refetchInterval` only while `status` is `pending`/`archiving`.

`keep-app-and-core-seperate`: types and API client in `@dna/core`, hook and visuals in
`@dna/app`.

## D7 — The player

**A fourth tab, "Recording", in `AssistantPanel.tsx`.** It already owns a Radix
`Tabs.Root` with the right props and tab furniture, it sits beside the Transcript tab
— the video is the transcript's other half — and it costs zero layout work in
`ContentArea.tsx`, so the review UI is untouched when the flag is off.

`VirtualCutPlayer.tsx` — one `<video src={media_url} controls preload="metadata">`:
- Seek to `cuts[n].video_in_seconds` on mount, version change, and clip selection.
- Guard seeks behind `loadedmetadata` — setting `currentTime` earlier is a silent
  no-op. Keep a `pendingSeekRef` and flush it in the handler.
- `timeupdate`: at `>= video_out_seconds`, pause. It fires ~4/s, so overshoot is
  ~250 ms; clamping on pause avoids drift.
- Multiple cuts: a Radix `SegmentedControl` — "Clip 1 / 2 / 3" with durations.
- Empty states driven by `status`, including "still being archived".

**Flag:** `VITE_FEATURE_RECORDING_PLAYBACK` → `recordingPlaybackEnabled`, chained
under `transcriptionEnabled` the way `inReviewEnabled` already is (no cuts without
persisted segments). Add to `SettingsModal.tsx` and `vite-env.d.ts`.

## D8 — Tests

Backend ≥90% on new `dna/` code: cut builder (ported + the `recording_t0` fallback
ladder), chunk pass-through, the archive/delete ordering guard, all `status`
branches, lazy resolution caching, the six new provider methods against a mocked
httpx transport. Collector: unit tests for resume-after-restart, chunk hash mismatch,
and refusal to delete without a recorded archive.

Frontend vitest: `useRecordingCuts`, and `VirtualCutPlayer` with `HTMLMediaElement`
stubbed on the ref (jsdom does not implement playback — assert on `currentTime`
writes and `pause` calls).

`make format-python` + `npm run format`; every commit `git commit -s` (DCO);
screenshot or gif in the PR.

---

# Phases

Vexa's own docs concede the live recording loop was **never validated end to end**
(`docs/docs/roadmap/status.mdx:98`), so every phase names the assumption it is
testing and ends with a check that can fail. Do not start a phase until the previous
one's check is green.

### Phase 1 — Does screencast capture actually work?
*Assumption under test: CDP screencast records the real meeting under CDP attach, and
the pacer keeps video time equal to wall time.*

V1a (ffmpeg in the bot image), V1b (screencast sink + `FramePacer`, writing to a
**local file** for now), V1c (bot wiring behind `captureModes`). No chunking, no
upload, no DNA.

**Check:** join a real meeting, `docker cp` the file out, play it. It must show the
meeting rather than a blank desktop, and `ffprobe` duration must be within ~1 s of
wall-clock elapsed. Deliberately sit still for two minutes and confirm the duration
still tracks — that is the pacer working. Unit tests for `FramePacer` land here too.

This is the highest-risk phase and the cheapest place to discover a problem.

### Phase 2 — Do chunks survive the round trip?
*Assumption under test: byte-split fMP4 concatenates back to a playable file, and a
prefix plays too.*

Switch ffmpeg to `pipe:1`, chunk the byte stream, upload via the existing
`/internal/recordings/upload`. V4 (mp4 content types, `master_finalized`,
`start_time_utc`). DNA's compose gains MinIO (Risk 3).

**Check:** chunks land in MinIO *during* the meeting; the assembled master is
byte-identical to the concatenation; the first three chunks alone still play.

### Phase 3 — Can the outside world read chunks mid-meeting?
*Assumption under test: chunks are readable while the recording is still in progress.*

V2 (chunk index + bytes routes, `lane:contract`) and V3 (`DELETE /recordings/{id}`).

**Check:** `curl` the index repeatedly during a live meeting and watch it grow; fetch
and verify per-chunk hashes; delete afterwards and confirm the objects are gone.

**Start the `lane:contract` review at the beginning of this phase** — it is the only
human-gated step and sits on the critical path.

### Phase 4 — Can DNA relay it?
*Assumption under test: the pass-through works and the delete guard holds.*

D1 (provider methods), D2 (chunk pass-through + archive/delete), D3 (metadata fields).

**Check:** curl the DNA endpoints from the prod host; confirm `DELETE` is **refused**
until an archive is recorded.

### Phase 5 — Does the airgap loop close?
*Assumption under test: the collector can assemble, mux, verify and archive
unattended, and survive a restart.*

The collector service, nginx location, ffmpeg in the collector image.

**Check:** run a meeting; watch the staging file grow during it; kill and restart the
collector mid-meeting and confirm it resumes rather than restarts; confirm the final
hash matches, the file is at the network path, and the upstream copy is gone.

### Phase 6 — Do the cuts land on the right shot?
*Assumption under test: `segment_wall_time - recording_t0` is a correct video offset.*

D4 (port the cut-list builder), D5 (cut-list endpoint).

**Check:** take a transcript segment, compute its offset, seek the archived MP4 there,
and confirm the audio matches the text. **This is the assumption the whole feature
rests on** — a few seconds of error puts clips on the wrong shot.

### Phase 7 — The view
D6 (types + hook), D7 (player + tab + flag).

**Check:** a review with several versions toggled in review; each version's Recording
tab plays the right span.

**Parallelism.** D4 is a cherry-pick with tests already written and depends on
nothing — bank it any time for a green slice. V5 (gateway headers) is likewise
independent. Everything else is genuinely sequential.

# Risks

1. **Backgrounded-tab throttling — highest technical risk.** Under CDP attach the
   bot's tab lives in a shared browser where a human may focus another tab. Chromium
   can throttle or halt `screencastFrame` for a hidden target. `bringToFront()` helps
   but a human can undo it. The pacer degrades this gracefully — a frozen frame, not
   a broken timeline — but you could record a still image for minutes. Worth a spike
   in Phase 1: `Page.setWebLifecycleState('active')` /
   `Emulation.setPageVisibilityOverride`.
2. **DNA's compose has no MinIO.** `docker-compose.vexa.yml` wires `vexa-db` but no
   object storage, and recordings cannot be stored without it. An unscoped compose
   change sits inside Phase 2 — budget real time for it.
3. **Airgap link characteristics are undocumented.** Nothing in the repo says whether
   it is bandwidth-constrained or intermittent, and there is no resume on the
   existing WS. The collector's resumable pull is designed for the worst case, but
   ~400 MB per meeting over an unknown link is a real operational unknown. Measure it
   in Phase 5.
4. **The checked-in `docker/airgap/.env` is stale** relative to `.env.example` — no
   `BACKEND_URL`, no `REVIEW_SESSIONS_URL`, still carrying old all-in-one keys. Fix
   it while adding the collector, or the collector inherits the same confusion.
5. **Clock skew.** `recording_t0` is the bot container's clock; segment timestamps
   come from meeting-api's. Same host they agree; across hosts they may not.
   `recording_t0_source` plus a `RECORDING_T0_OFFSET_SECONDS` nudge makes this
   debuggable. Phase 6 catches it.
6. **Unbounded storage.** Recordings are kept indefinitely on the share by decision.
   At roughly 200–400 MB per meeting this accumulates; worth watching even though no
   expiry is being built.
7. **`upload()` buffers whole files in memory.** Chunked upload largely fixes this,
   but confirm in Phase 2 that the bot streams rather than accumulating.
