import type {
  AccountPoolConfig,
  AccountQuota,
  PoolProvider,
} from "./contracts.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import { filterRequestHeaders, mountedUpstreamUrl } from "./provider-adapter.js";
import { isQuotaRejection, modelFamily, quotaFromHeaders } from "./quota.js";
import { parseRequestBody } from "./request-body.js";

export const ZAI_MOUNT_PREFIX = "zai/";
export const OPENCODE_GO_MOUNT_PREFIX = "opencode-go/";

const USAGE_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "user-agent",
]);
const ALLOWED_REQUEST_HEADER_PREFIXES = ["x-stainless-"];

export interface OpenAiCompatibleAdapterOptions {
  provider: PoolProvider;
  upstreamName: string;
  mountPrefix: string;
  upstreamBaseUrl: (settings: AccountPoolConfig) => string;
  usagesUrl: string;
  allowedHeaderPrefixes?: readonly string[];
  parseUsages: (
    accountId: string,
    payload: unknown,
    previous: AccountQuota,
    now: number,
  ) => AccountQuota | null;
}

export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleAdapterOptions,
): ProviderAdapter {
  return {
    provider: options.provider,
    upstreamName: options.upstreamName,
    async importAccount() {
      throw new Error(
        `${options.upstreamName} accounts carry no local login to import; add them with --api-key-stdin.`,
      );
    },
    parseRequest(body) {
      const parsed = parseRequestBody(body);
      return {
        family: modelFamily(null),
        affinityId: parsed.affinityId,
        parentAffinityId: parsed.parentAffinityId,
        forAccount: () => body,
      };
    },
    upstreamUrl: (request, settings) =>
      mountedUpstreamUrl(
        request,
        options.upstreamBaseUrl(settings),
        `${options.mountPrefix}v1/`,
      ),
    requestHeaders(inbound, _account, secret) {
      const headers = filterRequestHeaders(inbound, ALLOWED_REQUEST_HEADERS, [
        ...ALLOWED_REQUEST_HEADER_PREFIXES,
        ...(options.allowedHeaderPrefixes ?? []),
      ]);
      if (secret.kind !== "api-key") {
        throw new Error(
          `${options.upstreamName} accounts require an API key secret.`,
        );
      }
      headers.set("authorization", `Bearer ${secret.apiKey}`);
      return headers;
    },
    quotaFromHeaders,
    isQuotaRejection,
    async refreshSecret(context) {
      return { secret: context.secret, refreshed: false };
    },
    refreshesApiKeyUsage: true,
    async refreshUsage(context) {
      const secret = await context.freshSecret();
      if (secret.kind !== "api-key") return;
      const response = await context.fetch(options.usagesUrl, {
        headers: {
          authorization: `Bearer ${secret.apiKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const quota = options.parseUsages(
        context.account.id,
        await response.json().catch(() => null),
        context.quotas.get(context.account.id),
        context.now(),
      );
      if (quota !== null) context.quotas.put(quota);
    },
    errorResponse(status, message, headers) {
      return Response.json(
        {
          error: {
            message,
            type: status === 429 ? "rate_limit_error" : "api_error",
            code: status === 429 ? "rate_limit_exceeded" : null,
          },
        },
        { status, headers },
      );
    },
  };
}
