import type { ProviderAdapter } from "./provider-adapter.js";
import { filterRequestHeaders, mountedUpstreamUrl } from "./provider-adapter.js";
import { isQuotaRejection, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";

export const KIMI_MOUNT_PREFIX = "kimi/";

const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["anthropic-", "x-stainless-"];

export function createKimiAdapter(): ProviderAdapter {
  return {
    provider: "kimi",
    upstreamName: "Kimi For Coding",
    inboundToken: (headers) => headers.get("x-api-key"),
    async importAccount() {
      throw new Error(
        "Kimi For Coding accounts carry no local login to import; add them with --api-key-stdin.",
      );
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        family: parsed.family,
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: (account) => parsed.forAccount(account.accountUuid),
      };
    },
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(
        request,
        settings.kimiUpstreamBaseUrl,
        `${KIMI_MOUNT_PREFIX}v1/`,
      ),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(
        inbound,
        ALLOWED_REQUEST_HEADERS,
        ALLOWED_REQUEST_HEADER_PREFIXES,
      );
      if (secret.kind !== "api-key") {
        throw new Error("Kimi For Coding accounts require an API key secret.");
      }
      headers.set("x-api-key", secret.apiKey);
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      return { secret: context.secret, refreshed: false };
    },
    async refreshUsage() {},
    errorResponse(status, message, headers) {
      const type =
        status === 401
          ? "authentication_error"
          : status === 429
            ? "rate_limit_error"
            : "api_error";
      return Response.json(
        { type: "error", error: { type, message } },
        { status, headers },
      );
    },
  };
}
