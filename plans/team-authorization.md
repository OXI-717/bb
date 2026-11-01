# Team authorization in one shared BB

Status: verified token-validation prototype and implementation proposal, 2026-11-01. No authorization boundary is shipped by this change.

## Problem and acceptance

A shared server currently identifies plugin RPC callers as a plugin or a client.
That distinction does not identify an employee. A profile ID, a thread's author,
a machine ID, and a forwarded username must never substitute for an authenticated
acting subject. Authentication at a web gateway alone does not constrain direct
HTTP, WebSocket, terminal, file, agent SDK, or host RPC access.

The deployment must keep one shared BB and its existing threads. Acceptance requires:

- Two clients authenticate as different employees. Spoofing a profile ID does not
  change permissions or which provider account is selected.
- Either employee can continue a shared thread, using the current employee's
  provider authorization rather than the previous author's authorization.
- Twenty to thirty new threads reuse personal authorization. Server and execution
  host restarts preserve the authorization binding and recoverable session state.
- Files, terminals, direct API calls, alternate ingress and host RPC cannot reveal
  another employee's provider authorization or automation access.
- A personal automation check creates only its own paused test definition, and
  retrying its idempotency key returns the same run. Production jobs are not run.
- Unattended work uses a dedicated service subject. Audit records retain the
  verified human initiator separately. Revocation takes effect for subsequent
  operations, including an already open client connection.

## Trust and process boundaries

The server is the authority for authentication, policy and provider account
selection. The execution daemon performs host-local operations. Agent prompts,
workspace contents, plugins installed by employees, and execution subprocesses
are not authorities for an employee identity.

The control plane and credential broker must run under a different operating
system identity from execution subprocesses. Keeping secret files out of the
workspace alone is insufficient when terminals and agents run as the same user
as the server. Execution users must not read broker files, inspect its process
memory, access its administrative socket, or obtain unrestricted sudo access.
Host root and the infrastructure administrator remain trusted.

The existing Management API application is an administrative service application.
It must not become a shared employee login or a provider credential. Existing
automation JWT verification remains a separate resource audience and service.

## Authentication

Use a dedicated interactive OIDC application and resource audience for BB.
Authorization code with PKCE authenticates a client; validate issuer, audience,
signature algorithm, expiry, nonce and state. Only configured HTTPS endpoints are
trusted. Bound JWKS fetch size, timeout and cache lifetime; do not follow redirects.
Never accept a JWT URL, algorithm, issuer or verification key chosen by the caller.

Persist refresh material encrypted in the control-plane store, indexed by issuer
and subject. Browser sessions use secure HTTP-only cookies and explicit CSRF
protection. CLI and SDK callers use independently revocable access credentials.
Never place bearer tokens in query strings, event payloads, thread history or logs.
The same session applies to HTTP and WebSocket authorization. An open connection
must not retain authority after its session or subject is revoked.

Owner recovery and daemon enrollment remain separate, explicitly authenticated
flows. Loopback addresses and forwarded headers do not grant employee authority.
When authorization is enabled, missing policy, an unavailable authenticator, and
unclassified endpoints deny access. Startup must not silently disable the mode.

## Authorization and propagation

Introduce an immutable verified principal containing issuer, subject, session ID
and principal kind. Keep display names and Telegram metadata outside the authority
fields. Attach the principal at the transport boundary after verification.

Inventory and classify every route, WebSocket action, plugin RPC, file/terminal
operation, provider-management operation and host command. Evaluate permissions
against the server-resolved project, host and operation before performing it.
Do not authorize a resource ID from a body without resolving its actual ownership.
Unknown operation classes deny by default in team mode.

Extend the experimental RPC context with verified principal information. A plugin
caller token continues to identify the calling plugin; it does not impersonate a
human. Service-to-service calls carry an explicit service identity and a separate
server-issued initiator reference. Accept neither field from arbitrary clients.
Document the public SDK change in the Plugin Guide, API map and audit inventory.

Host commands receive a short-lived, audience-bound authorization envelope tied
to the resolved operation and target. The daemon validates the envelope before
execution. Direct daemon connections and legacy payloads must not bypass policy
in team mode. A wire change requires a daemon protocol version bump and tests
against the previously shipped daemon.

## Provider accounts and automation

Bind provider authorization to the verified acting subject, independently of
thread authorship and workspace profile. The server resolves the account when
dispatching a turn and persists its subject/account attribution with the turn.
Retries keep that immutable attribution. A later user turn resolves the new
acting subject; it must not inherit a previous turn's provider environment.

Keep the reusable authorization in the broker. Execution gets only the minimum
material required for that subject's current turn in an isolated process and
private temporary home. Do not copy another subject's authorization into a
shared workspace, daemon home or reusable terminal environment. Teardown removes
temporary material without deleting the broker's durable authorization.

Calls to the automation API use its existing explicit subject-to-actor bindings
and scope checks. Unattended jobs resolve a service subject; human initiators are
audit metadata with no ability to expand service permissions. Local service reader
access remains read-only. Thread profiles cannot select a privileged actor.

## Delivery sequence and verification

1. Inventory current ingress, daemon commands, provider authorization paths and
   session persistence. Add adversarial tests for the existing bypasses first.
2. Add the verified-principal contract and opt-in, fail-closed transport guard.
   Cover direct requests, forged headers, malformed and wrong-audience tokens,
   stale/revoked sessions and WebSocket upgrades. Keep default single-user mode.
3. Add operation policy and SDK/CLI surfaces. Test that every classified transport
   reaches policy and that new/unclassified operations deny in team mode.
4. Add broker-backed account selection, immutable turn attribution and process
   isolation. Test cross-user thread continuation, file access, terminal access,
   process environments, SDK calls, and direct host requests.
5. Add an isolated two-client acceptance environment with test provider accounts
   and a paused automation. Exercise thirty threads, restart, revocation and
   idempotency without starting production jobs.
6. Obtain review on the exact tested changes. Deploy through a separate reversible
   control-plane/execution-user migration with backup and recovery access, then
   repeat the two-client acceptance. Update the team automation runbook.

Run focused tests on accepted fleet test runners with bounded workers and load.
Do not substitute a successful unit test for deployed isolation or restart tests.
Do not enable personal writer access on the existing production server before
the complete authorization and process boundary passes acceptance.

## Alternatives considered

A web-only proxy supplies an identity but leaves alternate transports and shared
execution credentials exposed. A plugin-only check cannot cover direct file and
terminal operations. Separate BB instances provide a clearer process boundary,
but conflict with the required shared BB. The core guard plus credential broker
and isolated execution preserves that requirement.

## Prototype status and execution evidence

The initial prototype is `apps/server/src/services/team-token-verifier.ts`, with
adversarial cases in `apps/server/test/security/team-token-verifier.test.ts`.
It verifies ES384/RS256 resource tokens, bounds JWKS retrieval, rejects redirects,
requires registered claims, limits cache lifetime and refresh frequency, and
returns an immutable principal without copying arbitrary profile metadata.
It is deliberately not connected to server routes: token validation alone does
not provide the authorization and process isolation specified above.

On 2026-11-01 both `oxi-lw` and `leaseweb-lab` initially failed the official remote
runner doctor at the SSH check (exit 255). Investigation identified host-key
verification, rather than network reachability, as the cause. The LW public host
key was independently read over its enrolled BB connection, matched against the
SSH endpoint, and appended to the controller's known-hosts file. Strict host-key
verification remains enabled; the mismatched Leaseweb lab key was not replaced.
The subsequent LW doctor reached the server and passed its isolation, integrity,
disk, memory and load checks, but returned `not_prepared` for cache manifests whose
controller source paths were missing. It reported approximately 89 GB free disk,
50 GB available memory, sixteen CPUs and load 2.97.

The `ws-ilya` doctor passed with load 0.01,
four CPUs and approximately 13 GB available memory. A remote preparation attempt
was rejected before upload/execution with `push_blocked_secret_pattern` (exit 70):
the existing source contains `plugins/account-pool/src/fixtures/localhost-key.pem`.
No key content was printed or transferred. No test command started. Do not weaken
the transfer policy or delete the fixture to make the upload pass.

Syntax parsing with Node and `git diff --check` passed on the controller; neither
is a test result, a TypeScript typecheck, or proof of deployed authorization.
These were the initial blockers; the following execution resolved them for the
prototype. No production access changed.

### Successful ws-ilya verification

The owner clarified that AIM development and testing belong on ws-ilya. Source
was cloned/fetched directly from the public fork on that machine. No controller
source bundle or PEM exception was used. Existing key fixtures were unchanged.
Node and dependency preparation used the private test workspace; test execution
used the existing root-owned `oxi-test-sandbox` with its network isolation intact,
two-CPU affinity, two Turbo tasks and two Vitest workers. Compiler paths were
explicit because the sandbox does not expose distribution alternatives in /etc.

Verification at code commit `50637ae58d023d1efdd1a8e7d9e6de22f1fe5339`:

- Server typecheck: PASS (`turbo run typecheck --filter=@bb/server`).
- Complete server suite: 369 files passed, three corpus files skipped; 3814 tests
  passed, one corpus test skipped (`turbo run test --filter=@bb/server`).
- The initial focused run passed all 25 new verifier cases and four existing
  public authorization regression cases.
- The first complete run exposed a missing offline FRP archive and three HOME
  installer tests invoking real npm after a mocked 404. The FRP cache was warmed
  from the official release and checked against the repository's pinned hash.
  The HOME test now stubs npm, fails the mock install deliberately, and asserts
  that the install branch was reached. All 53 installer and 12 tunnel tests passed
  on focused reruns, followed by the complete successful run above.

ServeLat (`aim-infra-read-v1`) reviewed the complete verifier and its complete test
file in separate untruncated requests and returned PASS for both. This is a
file-level supplemental review: the fork/commit was not in its repository
projection, and it explicitly did not approve end-to-end authorization or
production deployment. The unchanged transport, account selection, isolation and
acceptance work described above remains required.
