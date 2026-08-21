# SPI_TODO — fork-level decisions for the Imageworks vexa fork

Open questions that are **ours to answer**, not upstream's.

This is not `AGENTS.md` — that file is upstream's front door, pointing at their issues and their PR
process. This one is internal: a fork accumulates decisions with no upstream home, and the expensive
ones are the ones nobody wrote down.

**Deliberately light on current state.** Entries say what the *issue* is and where to look, not what
the code says today — that changes, and a stale note is worse than none. Re-derive specifics when
picking one up.

**Scope: the vexa fork only.** DNA's open questions live in its own plan doc. Operational how-to
(build order, TLS, running the stack) belongs in `MEETING-RECORDING-PLAYBACK-NOTES.md`.

Resolved entries move to the decision log rather than being deleted — the reasoning is the point.

---

## 1. We own an alone-monitor; upstream has its own

**Status: OPEN — deferred 2026-08-21.**

We built participant-based alone detection (`presence.ts`, commits `3a0918a9` / `fcf6457e`) to stop
a bot sitting in an empty meeting. Upstream independently built the same feature from a different
signal, with its own tests and eval. Neither knows about the other.

The signals are complementary rather than competing — ours reads the meeting UI, upstream's reads
audio activity — and they disagree about a meeting where everyone is present but silent. Upstream's
design explicitly allows more than one rule, so keeping ours as an additional check is possible.

Two related problems sit underneath, and both appear to be **already solved upstream**:

- On our fork the timeout is configured in more than one place, and the layer that actually fires is
  not the one the contract names. Changing the wrong one silently does nothing.
- Our public API advertises a timeout knob that is accepted and ignored.

**The decision is not "fix the timeout" — it is how much of this we should still be carrying.**
Anything we patch locally is likely to be code upstream has already written, which becomes merge
friction later. Revisit against current upstream, not against these notes.

**Careful:** the config layers interact. Making the contract field live without also correcting the
value it would then pick up leaves bots waiting far longer in empty rooms than intended — the exact
behaviour our monitor exists to prevent, and on a recording deployment it burns disk and a
concurrency slot. Change them together or not at all.

---

## 2. Merge cadence — how far behind do we choose to be?

**Status: OPEN — surfaced by entry 1.**

Entry 1 is a symptom. The real question is whether this fork tracks upstream on a cadence or
diverges until something forces a merge.

Measured 2026-08-21 (**re-measure before deciding anything**): 16 commits ours, 159 upstream since
the merge base, and roughly 60% of the files we touch have also changed upstream. Our changes are
not off in a quiet corner — they are in the same bot, gateway and contract files upstream is
actively working. The cost of a merge grows monthly, and nobody has chosen to accept it.

This shapes how we write everything else. A fork that merges regularly should prefer upstream's
abstractions and push fixes up; a fork that has permanently diverged should own its files outright.
We are currently paying the costs of both.

Some of our commits are upstreamable on their own merits — general bug fixes, not
Imageworks-specific behaviour. Sending those up shrinks the fork whatever else we decide.

---

## 3. `gate:config-contract` is RED

**Status: OPEN, pre-existing — from `cb09e142` (CDP-attach).**

Config keys are read by the code but not declared in the config contract. Small fix, fails the gate
for everyone, worth clearing regardless of entry 1.

---

## 4. A sealed-contract change is waiting on human review

**Status: OPEN.**

`5160dd55` reseals `api.v1`. Per AGENTS.md the seal diff *is* the review artifact and wants a human
on the PR rather than riding in on green gates. The contract files involved are also among those
upstream has changed, so this collides with entry 1 — settle it before or during a merge.

---

## 5. Non-monotonic DTS at audio chunk boundaries

**Status: OPEN — observed 2026-08-21, not diagnosed.**

Muxing an archived recording logs repeated non-monotonic DTS warnings on the audio, at the seams
where the uploaded chunks are concatenated. Playback and duration look correct, so nothing is proven
broken.

It matters because DNA's collector runs this transcode unattended on the airgapped side, where
nobody reads the log. Unknown: whether the per-boundary corrections accumulate over a long meeting,
and whether the cause is our chunked upload or ffmpeg's handling of a concatenated stream. Reproduce
on a long recording before assuming it is benign.

---

## Decision log

Resolved entries move here with their reasoning. Empty so far.
