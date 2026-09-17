import { z } from "zod";
import type { AccountSecret } from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { filterRequestHeaders, mountedUpstreamUrl } from "./provider-adapter.js";
import { isQuotaRejection, modelFamily, quotaFromHeaders } from "./quota.js";

export const CURSOR_MOUNT_PREFIX = "cursor/";
export const CURSOR_EXCHANGE_PATH = "auth/exchange_user_api_key";

/** Paths the Cursor CLI calls, observed on a live run through a forwarding proxy.
 *
 * The plugin HTTP router matches paths exactly, so every path the CLI may call has to
 * be mounted. A path missing here does not degrade gracefully: the machine gets a 404
 * from the hub and Cursor looks broken for no visible reason.
 */
export const CURSOR_PROXIED_PATHS: readonly string[] = [
  CURSOR_EXCHANGE_PATH,
  "aiserver.v1.AiService/AvailableModels",
  "aiserver.v1.AiService/GetUsableModels",
  "aiserver.v1.AiService/GetDefaultModelForCli",
  "aiserver.v1.AnalyticsService/BootstrapStatsig",
  "aiserver.v1.BidiService/BidiAppend",
  "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "aiserver.v1.DashboardService/GetPlanInfo",
  "aiserver.v1.DashboardService/GetUserPrivacyMode",
  "aiserver.v1.ServerConfigService/GetServerConfig",
  "agent.v1.AgentService/Run",
  "agent.v1.AgentService/RunSSE",
  "agent.v1.AgentService/RunPoll",
  "agent.v1.AgentService/GetUsableModels",
  "v1/bundle/archive",
  "settings",
];

const EXCHANGE_TIMEOUT_MS = 15_000;
const TOKEN_EXPIRY_SAFETY_MS = 60_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "content-type",
  "user-agent",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["connect-", "x-cursor-", "x-request-id"];

const exchangeResponseSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  })
  .passthrough();

interface MintedToken {
  accessToken: string;
  expiresAt: number | null;
}

/** `exp` of a JWT in epoch ms, or null when the token does not carry a readable one. */
function tokenExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "=",
    );
    const claims: unknown = JSON.parse(
      Buffer.from(padded, "base64url").toString("utf8"),
    );
    const exp =
      typeof claims === "object" && claims !== null
        ? (claims as { exp?: unknown }).exp
        : undefined;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1_000 : null;
  } catch {
    return null;
  }
}

export function createCursorAdapter(options: {
  exchangeUrl: string;
}): ProviderAdapter {
  const minted = new Map<string, MintedToken>();

  async function mint(
    accountId: string,
    apiKey: string,
    fetchImpl: typeof fetch,
    now: number,
  ): Promise<string> {
    const cached = minted.get(accountId);
    if (
      cached !== undefined &&
      (cached.expiresAt === null || cached.expiresAt - TOKEN_EXPIRY_SAFETY_MS > now)
    ) {
      return cached.accessToken;
    }
    const response = await fetchImpl(options.exchangeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Cursor rejected the pooled API key while minting an access token (http ${response.status}).`,
      );
    }
    const parsed = exchangeResponseSchema.parse(await response.json());
    // The refresh token stays here deliberately: the API key can mint a new access token
    // at any time, so the hub never has to hand a renewable credential to a machine.
    const token: MintedToken = {
      accessToken: parsed.accessToken,
      expiresAt: tokenExpiry(parsed.accessToken),
    };
    minted.set(accountId, token);
    return token.accessToken;
  }

  return {
    provider: "cursor",
    upstreamName: "Cursor",
    async importAccount() {
      throw new Error(
        "Cursor accounts carry no local login to import; add them with --api-key-stdin.",
      );
    },
    parseRequest(body) {
      // Cursor speaks Connect RPC with protobuf bodies. The hub routes by account, not by
      // model, so the body is forwarded untouched rather than parsed.
      return {
        family: modelFamily(null),
        affinityId: null,
        parentAffinityId: null,
        forAccount: () => body,
      };
    },
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(
        request,
        settings.cursorUpstreamBaseUrl,
        CURSOR_MOUNT_PREFIX,
      ),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );
      if (secret.kind !== "oauth") {
        throw new Error(
          "Cursor requests require an access token minted from the pooled API key.",
        );
      }
      headers.set("authorization", `Bearer ${secret.accessToken}`);
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      if (context.secret.kind !== "api-key") {
        return { secret: context.secret, refreshed: false };
      }
      const accessToken = await mint(
        context.account.id,
        context.secret.apiKey,
        context.fetch,
        context.now(),
      );
      // Not persisted: the stored secret stays the API key, and this derived token lives
      // only for the life of this request.
      const secret: AccountSecret = {
        kind: "oauth",
        accessToken,
        refreshToken: "",
        expiresAt: null,
      };
      return { secret, refreshed: false };
    },
    async refreshUsage() {},
    errorResponse(status, message, headers) {
      return Response.json({ error: { message, code: status } }, {
        status,
        headers,
      });
    },
  };
}
