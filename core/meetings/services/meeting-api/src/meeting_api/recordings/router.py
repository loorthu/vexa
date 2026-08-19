"""The recordings routes — mounted onto the unified meeting-api app (modular monolith, P2).

  * **POST /internal/recordings/upload** — the bot's chunk upload. Auth via the MeetingToken it
    carries (``Authorization: Bearer <token>``, re-verified here — the parent's
    ``require_recording_upload_token``). Multipart form: ``file`` + ``session_uid`` + media metadata.
    Folds the chunk into ``meeting.data['recordings']`` JSONB. ``include_in_schema=False`` (internal).
  * **GET /recordings** — the caller's recordings (from ``meeting.data``), scoped by the
    gateway-injected ``x-user-id``.
  * **GET /recordings/{recording_id}/master?type=audio|video** — finalize-on-read: build + upload the
    master if absent, then return its storage key. (The byte stream / Range download is P3.)
"""
from __future__ import annotations

import json
import os
from typing import Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from .jsonb import chunk_storage_key
from .ports import RecordingRepo, Storage
from .service import (
    SessionNotFound,
    _verify_meeting_token,
    delete_recording,
    finalize_master,
    upload_chunk,
)


def _content_type_for(media_format: str, media_type: str) -> str:
    """Container + stream -> content type. Shared so the byte routes cannot disagree: a chunk
    served as octet-stream while the master says video/mp4 is the kind of mismatch that only
    shows up as a player refusing to play one of them."""
    if media_format == "wav":
        return "audio/wav"
    if media_format == "webm":
        return "audio/webm" if media_type == "audio" else "video/webm"
    if media_format == "mp4":
        return "video/mp4" if media_type == "video" else "audio/mp4"
    return "application/octet-stream"



def _bearer_token(authorization: Optional[str]) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing recording upload token")
    return authorization.split(" ", 1)[1].strip()


def _resolve_user_id(x_user_id: Optional[str]) -> int:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="Missing user identity")
    try:
        return int(x_user_id)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid user identity")


def _parse_range(range_header: Optional[str], total: int) -> Optional[tuple[int, int]]:
    """Parse an HTTP ``Range: bytes=start-end`` header against a known total size.

    Returns the resolved INCLUSIVE ``(start, end)`` byte offsets, or ``None`` when there is no
    range / it is not a byte range we honor (caller serves the full 200 body). Raises
    ``HTTPException(416)`` for a syntactically valid but unsatisfiable range. Forms handled:
    ``bytes=start-end``, ``bytes=start-`` (to EOF), ``bytes=-suffix`` (last N bytes); a multi-range
    header (commas) honors only the FIRST range.
    """
    if not range_header:
        return None
    spec = range_header.strip()
    if not spec.lower().startswith("bytes="):
        return None  # only byte ranges; fall back to full body
    spec = spec[len("bytes="):]
    first = spec.split(",", 1)[0].strip()  # multi-range → honor the first
    if "-" not in first:
        return None
    start_s, _, end_s = first.partition("-")
    start_s, end_s = start_s.strip(), end_s.strip()
    try:
        if start_s == "":
            # bytes=-suffix → the last `suffix` bytes
            if end_s == "":
                return None
            suffix = int(end_s)
            if suffix <= 0:
                return None
            start = max(0, total - suffix)
            end = total - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s != "" else total - 1
    except ValueError:
        return None  # unparseable → fall back to full body
    if start < 0:
        return None
    if start >= total:
        # Syntactically valid but unsatisfiable → 416 with Content-Range: bytes */total.
        raise HTTPException(
            status_code=416,
            detail="Requested range not satisfiable",
            headers={"Content-Range": f"bytes */{total}", "Accept-Ranges": "bytes"},
        )
    end = min(end, total - 1)  # clamp to the last byte
    if end < start:
        return None  # e.g. bytes=5-3 → ignore, serve full body
    return start, end


async def _storage_size(storage: Storage, key: str) -> Optional[int]:
    """Object size without fetching the body when the adapter exposes ``size``; else ``None``."""
    sizer = getattr(storage, "size", None)
    if sizer is None:
        return None
    return await sizer(key)


async def _storage_get_range(storage: Storage, key: str, start: int, end: int) -> Optional[bytes]:
    """Fetch ONLY ``[start, end]`` (inclusive) when the adapter exposes ``get_range`` (S3 passes the
    Range through to ``get_object``); else ``None`` so the caller slices a full ``get()``."""
    getter = getattr(storage, "get_range", None)
    if getter is None:
        return None
    return await getter(key, start, end)


def build_router(
    repo: RecordingRepo,
    storage: Storage,
    *,
    token_secret: Optional[str] = None,
) -> APIRouter:
    """The recordings routes over the injected ``RecordingRepo`` + ``Storage`` ports."""
    router = APIRouter()

    @router.post("/internal/recordings/upload", include_in_schema=False)
    async def internal_upload_recording(
        file: UploadFile = File(...),
        session_uid: Optional[str] = Form(None),
        media_type: Optional[str] = Form(None),
        media_format: Optional[str] = Form(None),
        chunk_seq: Optional[int] = Form(None),
        is_final: Optional[bool] = Form(None),
        duration_seconds: Optional[float] = Form(None),
        sample_rate: Optional[int] = Form(None),
        start_time_utc: Optional[str] = Form(None),
        metadata: Optional[str] = Form(None),
        authorization: Optional[str] = Header(default=None),
    ):
        # The bot's RecordingService sends a JSON `metadata` part + the `file` (with flat chunk_seq/
        # is_final on chunk uploads). Parse `metadata` for the fields it carries (session_uid lives
        # only there); any flat Form field overrides its metadata counterpart.
        meta: dict = {}
        if metadata:
            try:
                meta = json.loads(metadata)
            except (ValueError, TypeError):
                meta = {}
        session_uid = session_uid or meta.get("session_uid")
        if not session_uid:
            raise HTTPException(status_code=422, detail="session_uid required (flat field or metadata)")
        media_type = media_type or meta.get("media_type") or "audio"
        media_format = media_format or meta.get("media_format") or meta.get("format") or "wav"
        chunk_seq = chunk_seq if chunk_seq is not None else int(meta.get("chunk_seq", 0) or 0)
        is_final = is_final if is_final is not None else bool(meta.get("is_final", True))
        duration_seconds = duration_seconds if duration_seconds is not None else meta.get("duration_seconds")
        sample_rate = sample_rate if sample_rate is not None else meta.get("sample_rate")
        # The recorder's own clock at its first frame. Persisted so a consumer can map a
        # wall-clock moment onto an offset in this media without guessing at upload latency.
        start_time_utc = start_time_utc or meta.get("start_time_utc")

        # Auth: accept either the INTERNAL_API_SECRET (the bot's internal upload uses it, like the
        # lifecycle callback; meeting is scoped by session_uid) OR a MeetingToken (carries its meeting_id).
        bearer = _bearer_token(authorization)
        internal_secret = os.getenv("INTERNAL_API_SECRET")
        token_meeting_id: Optional[int] = None
        if internal_secret and bearer == internal_secret:
            token_meeting_id = None  # internal auth → scope by session; skip the MeetingToken cross-check
        else:
            try:
                claims = _verify_meeting_token(bearer, secret=token_secret)
            except ValueError as e:
                raise HTTPException(status_code=401, detail=f"Invalid recording upload token: {e}")
            token_meeting_id = int(claims["meeting_id"])

        data = await file.read()
        try:
            receipt = await upload_chunk(
                repo, storage,
                token_meeting_id=token_meeting_id,
                session_uid=session_uid, data=data,
                media_type=media_type, media_format=media_format,
                chunk_seq=chunk_seq, is_final=is_final,
                duration_seconds=duration_seconds, sample_rate=sample_rate,
                start_time_utc=start_time_utc,
            )
        except SessionNotFound as e:
            raise HTTPException(status_code=404, detail=str(e))
        return JSONResponse(content=receipt)

    @router.get("/recordings")
    async def list_recordings(
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        recs = await repo.list_meeting_recordings(user_id)
        return JSONResponse(content={"recordings": recs})

    @router.get("/recordings/{recording_id}")
    async def get_recording(
        recording_id: int,
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        """Recording detail (api/meetings.mdx: GET /recordings/{recording_id}) — the single recording
        record, scoped to the caller. 404 if the id isn't one of the caller's recordings."""
        user_id = _resolve_user_id(x_user_id)
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), None)
        if rec is None:
            raise HTTPException(status_code=404, detail="Recording not found")
        return JSONResponse(content=rec)

    @router.get("/recordings/{recording_id}/master")
    async def get_recording_master(
        recording_id: int,
        request: Request,
        type: str = "audio",
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        # Find which meeting owns this recording (scoped to the caller).
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), None)
        if rec is None:
            raise HTTPException(status_code=404, detail="Recording not found")
        mf = next((m for m in rec.get("media_files", []) if m.get("type") == type), None)
        master_key = await finalize_master(
            repo, storage, meeting_id=rec["meeting_id"], recording_id=recording_id, media_type=type
        )
        if master_key is None:
            raise HTTPException(status_code=404, detail="No such media file to finalize")
        # The dashboard player (api.ts getRecordingMasterStreamUrl) reads ``raw_url`` and streams it via
        # the proxy — the master metadata (``storage_path``) alone is not playable. Point it at the byte
        # route below so playback actually resolves (recordings P3: master byte stream).
        media_file_id = (mf or {}).get("id")
        raw_url = (
            f"/recordings/{recording_id}/media/{media_file_id}/raw?type={type}"
            if media_file_id is not None
            else None
        )
        return JSONResponse(content={
            "id": recording_id,
            "type": type,
            "storage_path": master_key,
            "media_file_id": media_file_id,
            "raw_url": raw_url,
            "duration_seconds": (mf or {}).get("duration_seconds"),
            # The wall-clock instant this media's first frame was captured. A consumer aligning a
            # transcript moment to a media offset needs this anchor; without it the only proxy is
            # the server's first-chunk arrival, which includes encode + upload latency.
            "start_time_utc": (mf or {}).get("start_time_utc"),
        })

    def _resolve_media_file(rec: Optional[dict], media_file_id) -> dict:
        """The (recording, media_file) lookup every chunk route shares. 404s are deliberately
        indistinguishable from 'not yours' — list_meeting_recordings is already caller-scoped."""
        if rec is None:
            raise HTTPException(status_code=404, detail="Recording not found")
        mf = next(
            (m for m in rec.get("media_files", []) if str(m.get("id")) == str(media_file_id)),
            None,
        )
        if mf is None:
            raise HTTPException(status_code=404, detail="No such media file")
        return mf

    @router.delete("/recordings/{recording_id}")
    async def delete_recording_route(
        recording_id: int,
        x_user_id: Optional[str] = Header(default=None),
    ):
        """Purge one recording's media and its record, leaving the meeting and its transcript.

        Declared in api.v1 from the start but previously waived to DELETE /meetings/{p}/{n}, which
        takes the transcript with it. A caller that has durably archived the media elsewhere needs
        to drop just the media.
        """
        user_id = _resolve_user_id(x_user_id)
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), None)
        if rec is None:
            raise HTTPException(status_code=404, detail="Recording not found")
        result = await delete_recording(
            repo, storage,
            meeting_id=rec["meeting_id"], recording_id=recording_id,
            session_uid=rec.get("session_uid") or "", user_id=rec.get("user_id") or user_id,
        )
        return JSONResponse(content=result)

    @router.get("/recordings/{recording_id}/media/{media_file_id}/chunks")
    async def list_recording_chunks(
        recording_id: int,
        media_file_id: int,
        after: int = -1,
        x_user_id: Optional[str] = Header(default=None),
    ):
        """The parts index — what exists, how big, and with what hash, WITHOUT assembling.

        /master and /raw both serve the finalized master, which only answers "is it done yet".
        A consumer that wants each part as it lands — to mirror a recording across a link while
        the meeting is still running, verifying as it goes — needs this. ``after`` makes it a
        cheap poll: pass the highest seq already held and receive only what is new.

        ``complete`` is the recording's own COMPLETED state, so a poller knows when to stop
        without inferring it from a gap in arrivals.
        """
        user_id = _resolve_user_id(x_user_id)
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), None)
        mf = _resolve_media_file(rec, media_file_id)
        chunks = [c for c in (mf.get("chunks") or []) if int(c.get("seq", 0)) > after]
        return JSONResponse(content={
            "recording_id": recording_id,
            "media_file_id": mf.get("id"),
            "media_type": mf.get("type"),
            "format": mf.get("format"),
            "start_time_utc": mf.get("start_time_utc"),
            "duration_seconds": mf.get("duration_seconds"),
            "complete": rec.get("status") == "completed",
            "chunks": chunks,
        })

    @router.get("/recordings/{recording_id}/media/{media_file_id}/chunks/{chunk_seq}")
    async def get_recording_chunk(
        recording_id: int,
        media_file_id: int,
        chunk_seq: int,
        x_user_id: Optional[str] = Header(default=None),
    ):
        """One part's bytes, verbatim — NOT the assembled master.

        Deliberately does not finalize: finalizing mid-meeting would flip the recording to a
        state that says "done" while the bot is still uploading. The parts are immutable once
        written, so this is safe to serve while the recording is in progress.
        """
        user_id = _resolve_user_id(x_user_id)
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), None)
        mf = _resolve_media_file(rec, media_file_id)
        entry = next((c for c in (mf.get("chunks") or []) if int(c.get("seq", 0)) == chunk_seq), None)
        if entry is None:
            raise HTTPException(status_code=404, detail="No such chunk")
        key = chunk_storage_key(
            user_id=rec.get("user_id") or user_id,
            recording_id=recording_id,
            session_uid=rec.get("session_uid") or "",
            media_type=mf.get("type", "audio"),
            media_format=mf.get("format", "webm"),
            chunk_seq=chunk_seq,
        )
        data = await storage.get(key)
        if data is None:
            raise HTTPException(status_code=404, detail="Chunk object missing from storage")
        return Response(
            content=data,
            media_type=_content_type_for(mf.get("format", "webm"), mf.get("type", "audio")),
            headers={"X-Chunk-Sha256": entry.get("sha256") or "", "X-Chunk-Seq": str(chunk_seq)},
        )

    @router.get("/recordings/{recording_id}/media/{media_file_id}/raw")
    async def get_recording_media_raw(
        recording_id: int,
        media_file_id: int,
        request: Request,
        type: str = "audio",
        x_user_id: Optional[str] = Header(default=None),
    ):
        # Stream the finalized master bytes from object storage (recordings P3). The player fetches
        # /master first (which finalizes), then this; finalize-on-read here too as a safety net.
        user_id = _resolve_user_id(x_user_id)
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), None)
        if rec is None:
            raise HTTPException(status_code=404, detail="Recording not found")
        mf = next(
            (m for m in rec.get("media_files", []) if str(m.get("id")) == str(media_file_id)),
            None,
        )
        if mf is None:
            raise HTTPException(status_code=404, detail="No such media file")
        # Finalize-on-read: serve the ASSEMBLED master, never a raw part or the empty final-signal
        # chunk. #491 — the old guard (`if not mf.is_final`) trusted the media-file's is_final flag as
        # "storage_path is playable"; but after an empty-final fold storage_path names the zero-byte
        # signal chunk (0 bytes served) or, with the jsonb fix, the LAST data part (#412: last-part-
        # only). is_final must stop doubling as "playable" — the ONLY playable object is master.<fmt>,
        # so finalize (idempotent) unless storage_path already IS the master key, then re-read.
        # Finalize UNCONDITIONALLY. The old guard skipped this whenever storage_path already named
        # a master, which meant a master built mid-recording was served for ever — the very case
        # where it is guaranteed to be incomplete. finalize_master is now self-limiting: it rebuilds
        # only when the part count has moved, so a settled recording costs one storage list.
        await finalize_master(
            repo, storage, meeting_id=rec["meeting_id"], recording_id=recording_id,
            media_type=mf.get("type", type),
        )
        recs = await repo.list_meeting_recordings(user_id)
        rec = next((r for r in recs if r.get("id") == recording_id), rec)
        mf = next(
            (m for m in (rec or {}).get("media_files", []) if str(m.get("id")) == str(media_file_id)),
            mf,
        )
        storage_path = mf.get("storage_path")
        if not storage_path:
            raise HTTPException(status_code=404, detail="Media file has no storage path")
        media_format = mf.get("format", "webm")
        content_type = _content_type_for(media_format, mf.get("type", "audio"))

        # Honor HTTP Range so the <audio>/<video> element + dashboard proxy can seek without
        # downloading the whole master. Resolve total size cheaply (S3 head) when we can; only fall
        # back to fetching the full body if neither size() nor get_range() are available.
        range_header = request.headers.get("range") or request.headers.get("Range")
        total = await _storage_size(storage, storage_path)
        full_body: Optional[bytes] = None
        if total is None:
            full_body = await storage.get(storage_path)
            total = len(full_body)

        rng = _parse_range(range_header, total)  # may raise 416
        if rng is None:
            data = full_body if full_body is not None else await storage.get(storage_path)
            return Response(
                content=data,
                media_type=content_type,
                headers={"Accept-Ranges": "bytes", "Content-Length": str(len(data))},
            )

        start, end = rng
        slice_bytes: Optional[bytes] = None
        if full_body is None:
            slice_bytes = await _storage_get_range(storage, storage_path, start, end)
        if slice_bytes is None:
            if full_body is None:
                full_body = await storage.get(storage_path)
            slice_bytes = full_body[start : end + 1]
        return Response(
            content=slice_bytes,
            status_code=206,
            media_type=content_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes {start}-{end}/{total}",
                "Content-Length": str(len(slice_bytes)),
            },
        )

    return router
