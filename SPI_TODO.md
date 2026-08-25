# SPI_TODO — fork-level decisions for the Imageworks vexa fork

Open questions that are **ours to answer**, not upstream's.

This is not `AGENTS.md` — that file is upstream's front door, pointing at their issues and their PR
process. This one is internal: a fork accumulates decisions with no upstream home, and the expensive
ones are the ones nobody wrote down.

**Deliberately light on current state.** Entries say what the *issue* is and where to look, not what
the code says today — that changes, and a stale note is worse than none. Re-derive specifics when
picking one up.

**Scope: the vexa fork only** — what is specific to Vexa's own functionality and how this fork
implements it. The meeting-recording feature spans both repositories, and its design and
operational notes live once, in the DNA repository
(`.cursor/plans/meeting_recording_playback.plan.md` and `SPI_NOTES.md`) — including the build
order, TLS setup and stack bring-up for the services here. Duplicating them was already letting
the two copies drift apart.

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

## 5. The CA patches exist only in locally-built images

**Status: OPEN, environment-specific.**

The internal network's TLS interception means the bot's browser needs the internal root CA in its
NSS store, and the Python and Node builds need it too. That injection currently lives only in
images built by hand on one machine, so `make bot` wipes it and anyone else on the VPN gets to
rediscover the whole thing.

If this fork is going to be built regularly here, the injection belongs in the Dockerfiles behind
a build arg that is empty by default — off for upstream, set internally. Until then it is a trap
with no marker on it.

---

## 6. The pre-push gates validate the working tree, not the repository

**Status: OPEN — blocks every push from a machine that has ever run the stack.**

`gate:readme` walks the filesystem and fails on directories that are gitignored and contain
nothing tracked: downloaded model caches, build output, `__pycache__`. On this machine 18 of 18
failures were of exactly that kind, and not one was a tracked directory genuinely missing a
README. Since the gate can never pass, the only way to push is `--no-verify` — which skips
*every* gate, so the check meant to protect the repository ends up disabling all of them.

The cause is one function: `walkDirs` in `scripts/gates.mjs` enumerates directories with
`readdirSync`, skipping only dot-names, a small hardcoded set, and directories holding a
`.gateignore`. Nothing consults `.gitignore`, so the gates judge the machine rather than the
repository. Anything a contributor's checkout accumulates becomes a push failure.

A `.gateignore` marker per offending directory works and needs no commit (they sit inside ignored
paths), but it is the same workaround repeated forever, and only on the machine that applied it.

**The fix is small and belongs upstream**, not in this fork: have the walk skip anything
`git check-ignore` claims, or enumerate from `git ls-files` instead. Worth raising there rather
than patching here — it costs every contributor, not just us, and this fork's divergence is
already entry 2's problem.

---

## 7. Non-monotonic DTS at audio chunk boundaries

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
