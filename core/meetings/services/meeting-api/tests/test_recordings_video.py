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


