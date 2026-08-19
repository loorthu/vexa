"""The recordings flow — chunk upload + finalize → master in ``meeting.data`` JSONB.

Port of the parent ``recordings.internal_upload_recording`` + ``recording_finalizer`` CORE:

  * ``upload_chunk(...)`` — verify the MeetingToken, resolve the bot's ``MeetingSession`` by
    ``session_uid``, upload the chunk to object storage, fold it into the recording's JSONB payload
    (``jsonb.apply_chunk_to_recording``) under a read-modify-write on ``meeting.data['recordings']``,
    and return the upload receipt.
  * ``finalize_master(...)`` — concatenate a recording media-file's chunks into a master via the
    golden-locked ``build_recording_master`` codec, upload the master, and stamp the JSONB media-file
    (``storage_path`` → master key, ``finalized_by``, ``is_final``, ``playback_url``).

The codec itself (``meeting_api.build_recording_master``, recording.v1) is already ported +
golden-locked — this module only orchestrates the IO + the JSONB bookkeeping around it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from ..obs import log_event
from ..recording_codec import build_recording_master
from .jsonb import (
    apply_chunk_to_recording,
    chunk_storage_key,
    master_storage_key,
    recording_id_for_session,
)
from .ports import RecordingRepo, Storage

# Media content types (parent ``recording_codec._media_content_type``, reduced to the core set).
# Container -> content type. mp4 is the screencast video recorder's container (h264 in
# fragmented mp4); without it the byte route would serve application/octet-stream and a
# <video> element would refuse to play the master.
_CONTENT_TYPES = {"webm": "video/webm", "wav": "audio/wav", "mp4": "video/mp4"}


def _content_type(media_format: str) -> str:
    return _CONTENT_TYPES.get(media_format, "application/octet-stream")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class SessionNotFound(Exception):
    """The upload's ``session_uid`` matches no MeetingSession AND it is the final chunk → 404."""


async def upload_chunk(
    repo: RecordingRepo,
    storage: Storage,
    *,
    token_meeting_id: Optional[int],
    session_uid: str,
    data: bytes,
    media_type: str = "audio",
    media_format: str = "wav",
    chunk_seq: int = 0,
    is_final: bool = True,
    duration_seconds: Optional[float] = None,
    sample_rate: Optional[int] = None,
    start_time_utc: Optional[str] = None,
) -> dict:
    """Process ONE recording chunk upload. ``token_meeting_id`` is the verified MeetingToken's
    meeting_id (the route verifies the token before calling this).

    Returns ``{recording_id, media_file_id, storage_path, status, chunk_seq}``. When the session is
    not yet known and the chunk is non-final, returns ``{"status": "pending"}`` (the bot retries).
    """
    session = await repo.find_session(session_uid)
    if session is None:
        if not is_final:
            return {"status": "pending"}
        raise SessionNotFound(f"no MeetingSession for session_uid {session_uid}")

    meeting_id = session["meeting_id"]
    if token_meeting_id is not None and meeting_id != token_meeting_id:
        # A MeetingToken was used and was minted for a different meeting — fail closed.
        # (token_meeting_id is None for internal-secret auth, which is already meeting-scoped by session.)
        raise SessionNotFound("MeetingToken meeting_id does not match the session's meeting")

    owner = await repo.owner_of(meeting_id)

    # Find / start the bot recording for this session.
    recordings = await repo.get_recordings(meeting_id)
    existing_rec = next(
        (r for r in recordings if r.get("session_uid") == session_uid and r.get("source") == "bot"),
        None,
    )
    # DERIVED, not minted: two media streams' first chunks race here, and a per-caller random id
    # would strand the loser's object under an id the fold then discards (see
    # recording_id_for_session). Deriving from the session makes both compute the same id.
    recording_id = existing_rec["id"] if existing_rec else recording_id_for_session(session_uid)

    # Upload the chunk to object storage (idempotent by key; OUTSIDE the row lock).
    key = chunk_storage_key(
        user_id=owner or 0, recording_id=recording_id, session_uid=session_uid,
        media_type=media_type, media_format=media_format, chunk_seq=chunk_seq,
    )
    await storage.upload(key, data, content_type=_content_type(media_format))

    # G3 — fold the chunk into the JSONB ATOMICALLY: the mutator reads the LIVE recordings under one
    # row lock and folds cumulatively, so a concurrent chunk/finalize can't clobber it (the old
    # get_recordings → apply → put_recordings were SEPARATE transactions → lost update). The mutator
    # re-resolves the recording for this session, so it reuses an id created concurrently.
    def _fold(recs):
        ex = next(
            (r for r in recs if r.get("session_uid") == session_uid and r.get("source") == "bot"), None
        )
        rid = ex["id"] if ex else recording_id
        payload, transitioned_ = apply_chunk_to_recording(
            ex,
            recording_id=rid, meeting_id=meeting_id, user_id=owner or 0,
            session_uid=session_uid, media_type=media_type, media_format=media_format,
            storage_path=key, file_size=len(data), chunk_seq=chunk_seq, is_final=is_final,
            duration_seconds=duration_seconds, sample_rate=sample_rate,
            start_time_utc=start_time_utc,
        )
        others = [r for r in recs if r.get("id") != rid]
        return others + [payload], (payload, transitioned_)

    rec_payload, transitioned = await repo.mutate_recordings(meeting_id, _fold)
    recording_id = rec_payload["id"]

    media_file = next((mf for mf in rec_payload["media_files"] if mf["type"] == media_type), {})
    if transitioned:
        log_event(
            "recording_completed", audience="user", span="recordings.upload",
            user_id=owner, meeting_id=str(meeting_id),
            fields={"recording_id": recording_id, "media_type": media_type},
        )
    return {
        "recording_id": recording_id,
        "media_file_id": media_file.get("id"),
        "storage_path": key,
        "status": rec_payload["status"],
        "chunk_seq": chunk_seq,
    }


async def finalize_master(
    repo: RecordingRepo,
    storage: Storage,
    *,
    meeting_id: int,
    recording_id: int,
    media_type: str = "audio",
) -> Optional[str]:
    """Build + upload the master for a recording media-file and stamp the JSONB. Idempotent: if the
    master already exists in storage it is reused. Returns the master storage key, or ``None`` when
    there is nothing to finalize.
    """
    recordings = await repo.get_recordings(meeting_id)
    rec = next((r for r in recordings if r.get("id") == recording_id), None)
    if rec is None:
        return None
    mf = next((m for m in rec.get("media_files", []) if m.get("type") == media_type), None)
    if mf is None:
        return None

    media_format = mf.get("format", "wav")
    master_key = master_storage_key(mf["storage_path"], media_format)

    # Gather the chunk objects under the recording's prefix (excluding any prior master). This is
    # read every time so staleness can be detected; the prefix is still correct once storage_path
    # has become the master key, since both live in the same directory.
    prefix = mf["storage_path"].rsplit("/", 1)[0]
    keys = sorted(
        k for k in await storage.list(prefix) if not k.rsplit("/", 1)[-1].startswith("master.")
    )

    # REBUILD when parts have arrived since the master was built.
    #
    # This used to be `if not exists(master_key)`, so the first finalize won permanently. Reading
    # /master (or /raw) DURING a recording therefore froze the master at whatever existed in that
    # instant — and because finalizing also sets is_final and repoints storage_path at master.*,
    # every later finalize was suppressed and the truncation became permanent. A single mid-meeting
    # peek silently cost the rest of the recording: observed as a 1.0 MB master for a recording
    # whose own metadata said 8.3 MB across 66 parts.
    if not keys:
        # Nothing to build FROM — the parts are gone (swept after archiving) or none were ever
        # uploaded. Serve whatever master exists; the codec rejects an empty chunk list, and
        # rebuilding is meaningless with no parts. Reachable now that /raw finalizes on every
        # read rather than only when storage_path was not already a master.
        return master_key if await storage.exists(master_key) else None

    built_from = mf.get("finalized_chunk_count")
    is_stale = built_from is None or built_from != len(keys)
    if is_stale or not await storage.exists(master_key):
        chunks = [await storage.get(k) for k in keys]
        master_bytes = build_recording_master(chunks, media_format)
        await storage.upload(master_key, master_bytes, content_type=_content_type(media_format))

    # G3 — stamp the media-file finalized ATOMICALLY (read→modify→write under one row lock), so a late
    # concurrent chunk upload can't clobber the finalized master pointer (the master bytes are already
    # uploaded above, idempotently by key). The mutator re-reads the LIVE recording.
    def _stamp(recs):
        r = next((x for x in recs if x.get("id") == recording_id), None)
        if r is None:
            return recs, None
        m = next((x for x in r.get("media_files", []) if x.get("type") == media_type), None)
        if m is None:
            return recs, None
        m["storage_path"] = master_key
        m["is_final"] = True
        m["finalized_at"] = _now_iso()
        m["finalized_by"] = "recording_finalizer.master"
        # How many parts this master covers. The staleness check above compares against it, so a
        # master built mid-recording is rebuilt once more parts land instead of being served forever.
        m["finalized_chunk_count"] = len(keys)
        existing_pb = r.get("playback_url") or {}
        r["playback_url"] = {
            "audio": existing_pb.get("audio")
            or (f"/recordings/{recording_id}/master?type=audio" if media_type == "audio" else None),
            "video": existing_pb.get("video")
            or (f"/recordings/{recording_id}/master?type=video" if media_type == "video" else None),
        }
        others = [x for x in recs if x.get("id") != recording_id]
        return others + [r], master_key

    return await repo.mutate_recordings(meeting_id, _stamp)


def _verify_meeting_token(token: str, *, secret: Optional[str] = None) -> dict[str, Any]:
    """Verify a MeetingToken (HS256, ``ADMIN_TOKEN``-signed) and return its claims. Raises
    ``ValueError`` on a bad signature / expiry (the parent ``verify_meeting_token``)."""
    import base64
    import hmac
    import json
    import os

    secret = secret if secret is not None else os.environ.get("ADMIN_TOKEN")
    if not secret:
        raise ValueError("ADMIN_TOKEN not configured; cannot verify MeetingToken")
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError:
        raise ValueError("malformed MeetingToken")
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode(), signing_input, digestmod="sha256").digest()
    got = base64.urlsafe_b64decode(sig_b64 + "=" * (-len(sig_b64) % 4))
    if not hmac.compare_digest(expected, got):
        raise ValueError("MeetingToken signature mismatch")
    claims = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    exp = claims.get("exp")
    if exp is not None and int(datetime.now(timezone.utc).timestamp()) > int(exp):
        raise ValueError("MeetingToken expired")
    return claims
