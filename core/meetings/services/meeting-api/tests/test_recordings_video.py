"""recordings (video) — an mp4 video stream folds in alongside audio and stays playable.

Drives the SHIPPED ``upload_chunk`` / ``finalize_master`` / ``build_router`` over the in-memory
fakes, OFFLINE. Three properties this pins:

1. **The master is a byte-exact concat.** The screencast recorder splits ffmpeg's output by byte
   count, so putting the parts back together must reproduce the stream exactly. The codec reaches
   mp4 through its non-wav branch (plain concat) — no new codec path, no golden vectors touched.

2. **Audio and video coexist.** Both streams are seq 0 at their first chunk. ``media_type`` is what
   namespaces the object key, so without it the second stream would overwrite the first.

3. **``start_time_utc`` survives.** It is the recorder's own clock at frame 0 — the anchor a
   consumer needs to turn a transcript's wall-clock moment into an offset in the media. The server
   already records ``first_chunk_at``, but that is arrival time and carries encode + upload latency.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from meeting_api.recording_codec import build_recording_master
from meeting_api.recordings import build_router, finalize_master, upload_chunk
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage
from meeting_api.recordings.jsonb import apply_chunk_to_recording

SECRET = "test-admin-token"
USER = 7
MEETING_ID = 1
SESSION_UID = "conn-video"
START_UTC = "2026-08-18T20:22:03.700Z"

def _seeded():
    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=MEETING_ID, user_id=USER, session_uid=SESSION_UID)
    return repo, InMemoryStorage()


def _client_for(repo, storage):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(build_router(repo, storage, token_secret=SECRET))
    return TestClient(app)


# Stand-in for fragmented-mp4 bytes. The codec is byte-agnostic on the non-wav path, and using a
# counting pattern makes any dropped / duplicated / reordered part a visible mismatch.
def _part(tag: int, n: int = 16) -> bytes:
    return bytes([tag]) * n


async def _upload(repo, storage, *, seq, is_final, data, media_type="video", fmt="mp4",
                  start_time_utc=START_UTC):
    return await upload_chunk(
        repo, storage,
        token_meeting_id=None,
        session_uid=SESSION_UID,
        data=data,
        media_type=media_type,
        media_format=fmt,
        chunk_seq=seq,
        is_final=is_final,
        duration_seconds=None,
        sample_rate=None,
        start_time_utc=start_time_utc,
    )


@pytest.mark.asyncio
async def test_video_master_is_byte_exact_concat():
    """The whole point of chunking: parts in, identical stream out."""
    repo, storage = _seeded()
    parts = [_part(k) for k in range(5)]
    for seq, p in enumerate(parts):
        await _upload(repo, storage, seq=seq, is_final=False, data=p)
    await _upload(repo, storage, seq=len(parts), is_final=True, data=b"")   # COMPLETED signal

    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    assert mf["format"] == "mp4"

    key = await finalize_master(repo, storage, meeting_id=MEETING_ID, recording_id=rec["id"], media_type="video")
    assert key.endswith("/video/master.mp4"), key
    assert await storage.get(key) == b"".join(parts)


@pytest.mark.asyncio
async def test_audio_and_video_do_not_collide_at_seq_zero():
    """Both streams start at seq 0; media_type is what keeps them apart."""
    repo, storage = _seeded()
    await _upload(repo, storage, seq=0, is_final=False, data=_part(0xAA), media_type="video", fmt="mp4")
    await _upload(repo, storage, seq=0, is_final=False, data=_part(0xBB), media_type="audio", fmt="webm",
                  start_time_utc=None)

    rec = (await repo.list_meeting_recordings(USER))[0]
    types = sorted(m["type"] for m in rec["media_files"])
    assert types == ["audio", "video"], types

    video = next(m for m in rec["media_files"] if m["type"] == "video")
    audio = next(m for m in rec["media_files"] if m["type"] == "audio")
    assert video["storage_path"] != audio["storage_path"]
    assert await storage.get(video["storage_path"]) == _part(0xAA)
    assert await storage.get(audio["storage_path"]) == _part(0xBB)


@pytest.mark.asyncio
async def test_start_time_utc_round_trips_and_is_first_write_wins():
    """The alignment anchor persists, and a later chunk cannot move it."""
    repo, storage = _seeded()
    await _upload(repo, storage, seq=0, is_final=False, data=_part(1))
    await _upload(repo, storage, seq=1, is_final=False, data=_part(2), start_time_utc="2099-01-01T00:00:00Z")

    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    assert mf["start_time_utc"] == START_UTC, "a later chunk must not move the anchor"


def test_master_finalized_guard_covers_video():
    """A late chunk must not clobber a finalized master — for mp4 as well as the audio spellings.

    The guard used to match the two audio master filenames literally, so a video master was
    unprotected: one straggling chunk would repoint storage_path away from master.mp4.
    """
    prior = {
        "type": "video", "format": "mp4",
        "storage_path": "recordings/7/1/conn-video/video/master.mp4",
        "file_size_bytes": 100, "chunk_count": 3, "is_final": False,
    }
    rec = {"id": 1, "meeting_id": MEETING_ID, "user_id": USER, "session_uid": SESSION_UID,
           "source": "bot", "status": "in_progress", "media_files": [prior]}
    payload, _ = apply_chunk_to_recording(
        rec, recording_id=1, meeting_id=MEETING_ID, user_id=USER, session_uid=SESSION_UID,
        media_type="video", media_format="mp4",
        storage_path="recordings/7/1/conn-video/video/000009.mp4",
        file_size=10, chunk_seq=9, is_final=False,
        duration_seconds=None, sample_rate=None,
    )
    mf = next(m for m in payload["media_files"] if m["type"] == "video")
    assert mf["storage_path"].endswith("/master.mp4"), "late chunk clobbered the finalized master"


@pytest.mark.asyncio
async def test_raw_route_serves_video_mp4_content_type_and_honors_range():
    """A <video> will not play application/octet-stream, and cannot seek without Range."""
    repo, storage = _seeded()
    body = b"".join(_part(k, 64) for k in range(4))
    await _upload(repo, storage, seq=0, is_final=False, data=body)
    await _upload(repo, storage, seq=1, is_final=True, data=b"")

    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    client = _client_for(repo, storage)

    r = client.get(f"/recordings/{rec['id']}/media/{mf['id']}/raw?type=video",
                   headers={"X-User-Id": str(USER)})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("video/mp4"), r.headers["content-type"]

    r = client.get(f"/recordings/{rec['id']}/media/{mf['id']}/raw?type=video",
                   headers={"X-User-Id": str(USER), "Range": "bytes=0-15"})
    assert r.status_code == 206
    assert r.headers["content-range"].startswith("bytes 0-15/")
    assert len(r.content) == 16



# ── the chunk read API + per-recording delete (Phase 3) ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_chunk_index_lists_parts_with_hashes_while_in_progress():
    """A consumer must be able to see the parts BEFORE the recording is complete.

    /master and /raw only answer "is it done"; mirroring a recording as it is produced needs the
    parts index, with a hash per part so each can be verified on arrival.
    """
    repo, storage = _seeded()
    parts = [_part(k, 32) for k in range(3)]
    for seq, p in enumerate(parts):
        await _upload(repo, storage, seq=seq, is_final=False, data=p)

    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    client = _client_for(repo, storage)
    r = client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks", headers={"X-User-Id": str(USER)})
    assert r.status_code == 200
    body = r.json()

    assert body["complete"] is False, "recording is still in progress"
    assert body["start_time_utc"] == START_UTC
    assert [c["seq"] for c in body["chunks"]] == [0, 1, 2]
    assert [c["size_bytes"] for c in body["chunks"]] == [32, 32, 32]

    import hashlib
    assert [c["sha256"] for c in body["chunks"]] == [hashlib.sha256(p).hexdigest() for p in parts]


@pytest.mark.asyncio
async def test_chunk_index_after_returns_only_new_parts_and_reports_completion():
    """`after` is what makes polling cheap; `complete` is what makes it terminate."""
    repo, storage = _seeded()
    for seq in range(4):
        await _upload(repo, storage, seq=seq, is_final=False, data=_part(seq, 16))
    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    client = _client_for(repo, storage)

    r = client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks?after=1",
                   headers={"X-User-Id": str(USER)})
    assert [c["seq"] for c in r.json()["chunks"]] == [2, 3]

    # the empty COMPLETED signal: flips `complete`, and is NOT itself a part
    await _upload(repo, storage, seq=4, is_final=True, data=b"")
    r = client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks",
                   headers={"X-User-Id": str(USER)})
    body = r.json()
    assert body["complete"] is True
    assert [c["seq"] for c in body["chunks"]] == [0, 1, 2, 3], "the 0-byte marker must not be indexed"


@pytest.mark.asyncio
async def test_chunk_bytes_are_served_verbatim_and_match_their_hash():
    """The part route serves the PART, not the master — and advertises the hash to check it against."""
    repo, storage = _seeded()
    payload = _part(0xEE, 128)
    await _upload(repo, storage, seq=0, is_final=False, data=payload)
    await _upload(repo, storage, seq=1, is_final=False, data=_part(0xFF, 64))

    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    client = _client_for(repo, storage)

    r = client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks/0", headers={"X-User-Id": str(USER)})
    assert r.status_code == 200
    assert r.content == payload, "must be the part, not the assembled master"
    assert r.headers["content-type"].startswith("video/mp4")

    import hashlib
    assert r.headers["x-chunk-sha256"] == hashlib.sha256(payload).hexdigest()

    assert client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks/99",
                      headers={"X-User-Id": str(USER)}).status_code == 404


@pytest.mark.asyncio
async def test_reading_a_chunk_does_not_finalize_the_recording():
    """Finalizing mid-meeting would claim 'done' while the bot is still uploading."""
    repo, storage = _seeded()
    await _upload(repo, storage, seq=0, is_final=False, data=_part(1, 32))
    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    client = _client_for(repo, storage)

    client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks/0", headers={"X-User-Id": str(USER)})

    rec_after = (await repo.list_meeting_recordings(USER))[0]
    mf_after = next(m for m in rec_after["media_files"] if m["type"] == "video")
    assert rec_after["status"] != "completed"
    assert not (mf_after.get("storage_path") or "").rsplit("/", 1)[-1].startswith("master."), \
        "reading a part must not have built a master"


@pytest.mark.asyncio
async def test_delete_recording_purges_objects_and_record():
    """The waived route, implemented: media gone, meeting and transcript untouched."""
    repo, storage = _seeded()
    for seq in range(3):
        await _upload(repo, storage, seq=seq, is_final=False, data=_part(seq, 32))
    await _upload(repo, storage, seq=3, is_final=True, data=b"")
    rec = (await repo.list_meeting_recordings(USER))[0]
    await finalize_master(repo, storage, meeting_id=MEETING_ID, recording_id=rec["id"], media_type="video")

    assert len(await storage.list(f"recordings/{USER}/{rec['id']}/")) > 0
    client = _client_for(repo, storage)
    r = client.delete(f"/recordings/{rec['id']}", headers={"X-User-Id": str(USER)})
    assert r.status_code == 200
    assert r.json()["deleted_objects"] > 0

    assert await storage.list(f"recordings/{USER}/{rec['id']}/") == [], "objects must be gone"
    assert [x for x in await repo.list_meeting_recordings(USER) if x["id"] == rec["id"]] == []
    assert await repo.find_session(SESSION_UID) is not None, "the meeting session must survive"


@pytest.mark.asyncio
async def test_chunk_routes_and_delete_are_scoped_to_the_caller():
    """list_meeting_recordings is caller-scoped; another user must see 404, not someone's media."""
    repo, storage = _seeded()
    await _upload(repo, storage, seq=0, is_final=False, data=_part(1, 32))
    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    client = _client_for(repo, storage)
    other = {"X-User-Id": "999"}

    assert client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks", headers=other).status_code == 404
    assert client.get(f"/recordings/{rec['id']}/media/{mf['id']}/chunks/0", headers=other).status_code == 404
    assert client.delete(f"/recordings/{rec['id']}", headers=other).status_code == 404
    assert await storage.list(f"recordings/{USER}/{rec['id']}/") != [], "a 404 must not have deleted anything"


@pytest.mark.asyncio
async def test_master_read_mid_recording_does_not_truncate_the_final_master():
    """FIELD BUG: one mid-meeting peek at the master cost the rest of the recording.

    finalize_master built the master only `if not exists(master_key)`, so the FIRST finalize won
    permanently. Finalizing also sets is_final and repoints storage_path at master.*, which
    suppressed every later finalize. So reading /master (or /raw) while the bot was still uploading
    froze the master at whatever existed in that instant — for ever. Observed live: a 1.0 MB master
    for a recording whose own metadata reported 8.3 MB across 66 parts.

    RED before the fix (master stays at the first 3 parts), GREEN after.
    """
    repo, storage = _seeded()
    early = [_part(k, 32) for k in range(3)]
    for seq, p in enumerate(early):
        await _upload(repo, storage, seq=seq, is_final=False, data=p)

    rec = (await repo.list_meeting_recordings(USER))[0]

    # A consumer peeks at the master while the bot is still uploading (exactly what reading
    # media_file_id off /master does).
    key = await finalize_master(repo, storage, meeting_id=MEETING_ID,
                                recording_id=rec["id"], media_type="video")
    assert await storage.get(key) == b"".join(early), "the early master should cover what exists so far"

    # The meeting continues.
    later = [_part(0x40 + k, 32) for k in range(5)]
    for i, p in enumerate(later):
        await _upload(repo, storage, seq=3 + i, is_final=False, data=p)
    await _upload(repo, storage, seq=8, is_final=True, data=b"")

    key = await finalize_master(repo, storage, meeting_id=MEETING_ID,
                                recording_id=rec["id"], media_type="video")
    assert await storage.get(key) == b"".join(early + later), \
        "the master must cover the WHOLE recording, not just what existed at the first peek"


@pytest.mark.asyncio
async def test_settled_recording_is_not_rebuilt_on_every_read():
    """The staleness check must be a count comparison, not 'always rebuild'."""
    repo, storage = _seeded()
    for seq in range(3):
        await _upload(repo, storage, seq=seq, is_final=False, data=_part(seq, 32))
    await _upload(repo, storage, seq=3, is_final=True, data=b"")
    rec = (await repo.list_meeting_recordings(USER))[0]

    await finalize_master(repo, storage, meeting_id=MEETING_ID, recording_id=rec["id"], media_type="video")
    rec = (await repo.list_meeting_recordings(USER))[0]
    mf = next(m for m in rec["media_files"] if m["type"] == "video")
    stamped = mf.get("finalized_chunk_count")
    assert stamped is not None, "the finalizer must record how many parts the master covers"

    key = await finalize_master(repo, storage, meeting_id=MEETING_ID, recording_id=rec["id"], media_type="video")
    rec2 = (await repo.list_meeting_recordings(USER))[0]
    mf2 = next(m for m in rec2["media_files"] if m["type"] == "video")
    assert mf2.get("finalized_chunk_count") == stamped, "a settled recording must not keep rebuilding"


@pytest.mark.asyncio
async def test_concurrent_first_chunks_land_under_one_recording():
    """FIELD BUG: the video's init segment was stranded under a discarded recording id.

    Two media streams now upload at once. Each first chunk found no existing recording, minted its
    OWN random id, and uploaded its object under that id. The JSONB fold then serialized under the
    row lock and both converged on ONE recording — leaving the loser's object under an id nothing
    referenced. The master, assembled from the surviving prefix, began mid-fragment:

        trun track id unknown, no tfhd was found -> error reading header

    Observed live: 9 of 10 video parts present, the missing one being chunk 0 (ftyp + moov), and the
    whole recording unplayable. Deriving the id from the session removes the race by construction.

    THE INTERLEAVING MUST BE FORCED. The in-memory fakes never actually suspend, so a plain
    asyncio.gather runs the first upload to completion before the second begins and no race occurs —
    a test written that way stays green WITHOUT the fix, which is worse than no test. The storage
    fake below yields at exactly the point the real S3 call does: after the recording id has been
    chosen, before the JSONB fold. That is the window the two streams collided in.
    """
    import asyncio

    class YieldingStorage(InMemoryStorage):
        """Suspends inside upload, like a real network call, so the other stream can interleave."""

        async def upload(self, key: str, data: bytes, *, content_type: str) -> None:
            await asyncio.sleep(0)
            await super().upload(key, data, content_type=content_type)

    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=MEETING_ID, user_id=USER, session_uid=SESSION_UID)
    storage = YieldingStorage()

    video0 = b"\x00\x00\x00\x1cftypiso5" + b"\x11" * 32   # the init segment
    audio0 = b"\x1a\x45\xdf\xa3" + b"\x22" * 32           # webm EBML header

    # Both streams' FIRST chunk in flight together — neither can see an existing recording.
    await asyncio.gather(
        _upload(repo, storage, seq=0, is_final=False, data=video0, media_type="video", fmt="mp4"),
        _upload(repo, storage, seq=0, is_final=False, data=audio0, media_type="audio", fmt="webm",
                start_time_utc=None),
    )

    recs = await repo.list_meeting_recordings(USER)
    assert len(recs) == 1, f"the two streams created {len(recs)} recordings; they must share one"
    rec = recs[0]

    # Every object must live under the surviving recording's prefix — nothing stranded.
    all_keys = await storage.list("recordings/")
    stray = [k for k in all_keys if f"/{rec['id']}/" not in k]
    assert stray == [], f"objects stranded outside the recording: {stray}"

    # And the assembled video master must START with the init segment.
    key = await finalize_master(repo, storage, meeting_id=MEETING_ID,
                                recording_id=rec["id"], media_type="video")
    master = await storage.get(key)
    assert master.startswith(video0[:12]), "master does not begin with ftyp — init segment lost"
