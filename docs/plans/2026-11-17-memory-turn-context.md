# Fresh plugin reference context on each dispatched turn

The memory epic needs current project-scoped sources on a follow-up in the same provider session. Existing `contributeInstructions` intentionally freezes standing policy at session construction. The dispatch hook may decide admission but must not rewrite the request. Neither surface is a turn-context channel.

## Chosen boundary

Add `bb.agents.experimental_contributeTurnContext(provider)`, a synchronous, bounded callback with the exact thread ID, project ID and original dispatch input. It contributes reference data, never standing instructions. The existing first-turn and follow-up command builders share one helper. They add an `agent-only` text group to the provider command, preserving original input groups, attachment handling, original request records, provider identity and execution options. Existing daemon input fields and provider adapters already support these blocks, so no protocol change or per-turn session restart is needed.

One callback per plugin factory. Disabled/reloaded registrations disappear through the existing plugin lifecycle. Inputs are copied per provider. Null contributes nothing. Throws, malformed/async results, per-plugin overflow (16384 characters) and global overflow (32768 characters) omit that contribution with metadata-only diagnostics. Plugin data is JSON-encoded inside an explicit untrusted-reference envelope; embedded delimiters cannot escape it. Standing rules and access checks remain authoritative.

The memory consumer uses its existing bounded lookup and authenticated project mapping. Its cached result must match the exact normalized query, current project and short TTL; every dispatch clears stale context. On a host without this new API the old behavior stays available and honestly limited. The plugin must never claim fresh follow-up injection merely from a successful search or a new session.

## Acceptance

1. Real first/follow-up command regression fails on the unmodified BB base and passes after the shared helper is wired in both builders, including grouped inputs.
2. Focused tests cover ordering, isolation, overflow, bad callbacks, original-input preservation and registration lifecycle. Existing adjacent contribution/command tests stay green.
3. Linux Turbo builds/typechecks and focused tests; no full suite on the owner's Mac.
4. One independent review of the complete core/consumer package and normal source acceptance.
5. Deliver through the supported installation route only. One meaningful same-session first/second-turn live check with the original owner query and source/date/order evidence. A unit fixture or manual search does not establish live injection.

Existing memory data, grants, indexes, schedules and provider/model selection are outside this change.

## Private fork delivery

The additive API carries SDK version `0.6.133-memory.1657.0`, a private prerelease above the installed `0.6.132`; no npm SDK release is published. Existing CI checks run unchanged on GitHub-hosted runners in forks because the upstream Blacksmith runner labels are not available there. Upstream runner selection remains unchanged.

## Review correction and fork verification

The dispatch hook sees the original message before agent attribution, resolved
mentions and deferred startup context are appended. Preserve that input separately
through internal command builders and the backwards-compatible provisioning JSON;
providers still receive the fully augmented command input. The extra internal
field never crosses the host wire. Cold/warm mention dispatch and grouped commands
have a regression that failed on the reviewed predecessor.

The fork has no upstream provider credential: the authenticated provider-model
probe runs only in upstream, while ordinary tests remain enabled. Standard fork
Windows runners use two Vitest workers and one concurrent Turbo task; upstream
runner parallelism is unchanged. Git fixtures advance the bare remote directly,
so preparing a remote change cannot update client tracking refs before the test.
The initial fork failures remain recorded; corrected checks must pass before
source acceptance or production installation.
