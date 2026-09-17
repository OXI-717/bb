# Pooling Cursor: why there is a path list, and how to repair it

Cursor is the one pooled provider whose upstream surface we cannot cover generically.
The plugin HTTP router matches a request path by exact string (`plugin-service.ts`,
`route.path === path`), and Cursor speaks Connect RPC over many paths named after
protobuf services — `aiserver.v1.AiService/AvailableModels`, `agent.v1.AgentService/RunSSE`
and so on — which no prefix rule can enumerate ahead of time. So the plugin carries a
catalogue, `CURSOR_PROXIED_PATHS` in `src/cursor-adapter.ts`, and mounts each entry.

## The failure this causes

A path Cursor starts calling but we never mounted returns **404 from the hub**, not from
Cursor. On the machine this looks like Cursor breaking for no reason: a thread errors, or
the agent stalls, while `bb pool status` looks healthy and the account has quota. Nothing
in the pool reports it, because from the pool's side no request ever arrived.

Symptoms worth recognising:

- an `acp-cursor` thread fails right after start, before any model output;
- `Connection lost, reconnecting` repeated in the thread log;
- the same prompt works on a machine that uses Cursor directly (credential on the box).

## Recapturing the list

Run the CLI against a forwarding proxy and read the paths off the wire. Auth stays on the
real backend, so this cannot invalidate a stored login — pointing `CURSOR_API_ENDPOINT` at
something that answers 401 will (that is how this session once cleared a Keychain token).

1. Start a forwarder that logs `method path` and proxies to `https://api2.cursor.sh`,
   reading chunked request bodies and writing response chunks as they arrive. A blocking
   `read(n)` stalls Cursor's SSE stream and the client reconnects in a loop.
2. Exercise the CLI through it, agent stream included:

   ```bash
   PROBE=$(mktemp -d)
   printf '{"network":{"useHttp1ForAgent":true}}' > "$PROBE/cli-config.json"
   CURSOR_CONFIG_DIR="$PROBE" cursor-agent --print --trust \
     --agent-endpoint "http://127.0.0.1:<port>" "Reply with exactly: ok"
   ```

   `useHttp1ForAgent` keeps the agent stream on HTTP/1 so a plain proxy can carry it;
   without it the stream goes out over HTTP/2 and bypasses the hub.
3. Add whatever paths appear to `CURSOR_PROXIED_PATHS`, and to the pinned list in
   `src/server.test.ts` (`mounts every Cursor path the CLI is known to call`). The test
   pins the catalogue deliberately: iterating only the source list would stay green while
   a path silently disappeared from it.

## What must not be forwarded

`auth/exchange_user_api_key` is answered by the hub itself. The machine sends its pool
token as the key, and the hub replies with that same token as both `accessToken` and
`refreshToken`. The subscription key stays here and is exchanged for a short-lived access
token only when a request is actually forwarded upstream (`cursor-adapter.ts`, `mint`).
Forwarding this call instead would hand the machine a real renewable Cursor credential —
the precise thing pooling exists to prevent.
