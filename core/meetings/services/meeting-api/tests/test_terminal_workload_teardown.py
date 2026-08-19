"""A finished bot's container is reaped — for every way a run can end.

FIELD GAP this pins: nothing tore down the workload of a bot that exited on its OWN. The user-stop
route (``stop_router``) only deletes the workload when the bot is still BOOTING — an ACTIVE bot is
asked to leave and trusted to exit — and the reconcile sweep only chases orphans that are still
alive. So every normally-finishing bot (stopped, evicted, left_alone, max_bot_time_exceeded) left
its exited container behind indefinitely.

WHY THE TERMINAL EVENT IS THE RIGHT MOMENT: the bot emits ``completed`` only AFTER its teardown —
the orchestrator awaits ``pipeline.stop()``, which flushes and uploads the final recording chunks,
before emitting. So the media is durable in object storage before the container that produced it is
removed. Reaping any earlier would race the upload.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from meeting_api import create_app
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo

PLATFORM = "google_meet"
NATIVE = "abc-defg-hij"


@pytest.fixture(autouse=True)
def _spawn_env(monkeypatch):
    """Spawning mints a MeetingToken and requires a transcription backend — neither is what these
    tests are about, but both must be configured for POST /bots to reach the runtime."""
    monkeypatch.setenv("ADMIN_TOKEN", "test-admin-token")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.example")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")


def _client(repo, rt):
    return TestClient(create_app(meeting_repo=repo, runtime=rt))


def _spawn(client, *, reach_active: bool = True) -> tuple[str, str]:
    """Spawn a bot and walk it along the LEGAL lifecycle path. Returns (workload_id, conn).

    The FSM only accepts None -> joining as a first edge, so posting a terminal straight after
    spawn is a 409 and never reaches the teardown at all.
    """
    r = client.post("/bots", json={"platform": PLATFORM, "native_meeting_id": NATIVE},
                    headers={"X-User-Id": "1"})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    conn = body["data"]["sessions"][-1]
    path = ["joining", "awaiting_admission", "active"] if reach_active else ["joining"]
    for status in path:
        resp = client.post("/bots/internal/callback/lifecycle",
                           json=_event(status, reason="", connection_id=conn))
        assert resp.status_code == 200, f"{status}: {resp.status_code} {resp.text}"
    return body["bot_container_id"], conn


def _event(status: str, *, reason: str, connection_id: str, exit_code: int = 0) -> dict:
    ev = {
        "event": "status", "status": status, "platform": PLATFORM,
        "native_meeting_id": NATIVE, "connection_id": connection_id,
    }
    if status in ("completed", "failed"):
        ev["completion_reason"] = reason
        ev["exit_code"] = exit_code
    return ev


@pytest.mark.parametrize(
    "reason",
    [
        "stopped",                    # user pressed stop
        "left_alone",                 # everyone else hung up — the new bot-side signal
        "evicted",                    # host removed the bot
        "max_bot_time_exceeded",      # the lifetime cap tripped
    ],
)
def test_workload_is_reaped_for_every_completion_reason(reason):
    """"Under all circumstances" — however the run ended, the container goes."""
    repo, rt = InMemoryMeetingRepo(), FakeRuntimeClient()
    client = _client(repo, rt)
    workload_id, conn = _spawn(client)
    assert workload_id, "spawn must record a bot_container_id"
    assert rt.deleted == [], "an ACTIVE bot must never be torn down"

    client.post("/bots/internal/callback/lifecycle",
                json=_event("completed", reason=reason, connection_id=conn))
    assert workload_id in rt.deleted, f"container not reaped on completion_reason={reason}"


def test_failed_run_is_also_reaped():
    """A failed bot leaves a container behind exactly like a completed one."""
    repo, rt = InMemoryMeetingRepo(), FakeRuntimeClient()
    client = _client(repo, rt)
    workload_id, conn = _spawn(client)
    client.post("/bots/internal/callback/lifecycle",
                json=_event("failed", reason="join_failure", connection_id=conn, exit_code=1))
    assert workload_id in rt.deleted


def test_teardown_failure_does_not_fail_the_bot_callback():
    """The bot's terminal callback must be ACKed even if the reap fails.

    A 500 here would make the bot retry its terminal event, and the reconcile sweep is the
    backstop for a container that outlives its meeting — losing the callback is far worse than
    losing the reap.
    """
    class ExplodingRuntime(FakeRuntimeClient):
        async def delete_workload(self, workload_id: str) -> None:
            raise RuntimeError("runtime unreachable")

    repo, rt = InMemoryMeetingRepo(), ExplodingRuntime()
    client = _client(repo, rt)
    _workload_id, conn = _spawn(client)
    r = client.post("/bots/internal/callback/lifecycle",
                    json=_event("completed", reason="stopped", connection_id=conn))
    assert r.status_code == 200, "a failed teardown must not fail the callback"


def test_intermediate_transitions_never_reap():
    """Only a TERMINAL status reaps — a bot mid-meeting must keep its container."""
    repo, rt = InMemoryMeetingRepo(), FakeRuntimeClient()
    client = _client(repo, rt)
    _workload_id, _conn = _spawn(client)   # walks joining -> awaiting_admission -> active
    assert rt.deleted == [], f"reaped mid-run: {rt.deleted}"
