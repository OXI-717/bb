import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  type AccountPoolConfigController,
  type PoolProvider,
} from "./contracts.js";
import type {
  ImportedClaudeCredentials,
  ImportedCodexCredentials,
} from "./credentials.js";
import { createHub } from "./hub.js";
import {
  CURSOR_EXCHANGE_PATH,
  CURSOR_MOUNT_PREFIX,
  CURSOR_PROXIED_PATHS,
} from "./cursor-adapter.js";
import { KIMI_MOUNT_PREFIX } from "./kimi-adapter.js";
import {
  OPENCODE_GO_MOUNT_PREFIX,
  ZAI_MOUNT_PREFIX,
} from "./openai-compatible-adapter.js";
import { PoolOperations } from "./operations.js";
import { registerUsageSource } from "./usage-source.js";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  kimiUsagesUrl?: string;
  zaiUsagesUrl?: string;
  opencodeGoUsagesUrl?: string;
  cursorExchangeUrl?: string;
  cursorUsageUrl?: string;
  usageUrl?: string;
  drainTimeoutMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  importCredentials?: () => Promise<ImportedClaudeCredentials>;
  importCodexCredentials?: () => Promise<ImportedCodexCredentials>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");
function hubBasePath(pluginId: string): string {
  return `/api/v1/plugins/${pluginId}/http`;
}

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    let currentSettings = accountPoolConfigSchema.parse(
      (await bb.storage.kv.get("config")) ?? {},
    );
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const hubTokens = new HubTokenStore(secretDir, now);
    await hubTokens.initialize();
    const enrolledHosts = await bb.sdk.hosts.list();
    await hubTokens.prune(enrolledHosts.map((host) => host.id));
    const routing = new RoutingStore(bb.storage.kv, now);
    const db = bb.storage.database();
    bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    const hub = createHub({
      route: hubBasePath(bb.pluginId),
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      getSettings: () => currentSettings,
      fetch: upstreamFetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      kimiUsagesUrl: options.kimiUsagesUrl,
      zaiUsagesUrl: options.zaiUsagesUrl,
      opencodeGoUsagesUrl: options.opencodeGoUsagesUrl,
      cursorExchangeUrl: options.cursorExchangeUrl,
      cursorUsageUrl: options.cursorUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      importClaudeCredentials: options.importCredentials,
      importCodexCredentials: options.importCodexCredentials,
      drainTimeoutMs: options.drainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      onUpstreamError: (provider, error) =>
        bb.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
    });
    if (transport !== null) {
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      () => bb.sdk.hosts.list(),
      async (hostId) =>
        (await bb.sdk.system.providerStates({ hostId })).providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
    );
    const login = new ClaudeOAuthLogin({
      fetch: upstreamFetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool account add`.",
      );
    }
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(operations, login, codexLogin, config),
    );
    registerPoolCli(bb, operations, login, codexLogin, config);
    registerUsageSource(bb, hub);
    const proxiedHealth = async (provider: PoolProvider) =>
      (await operations.isRoutingEnabled(provider)) &&
      (await operations.hasUsableEnabledAccount(provider))
        ? {
            label: "Proxied",
            statusMessage:
              "Credentials are provided by the Account Pooler hub.",
          }
        : null;
    bb.providers.experimental_contributeEnv("claude-code", async (context) => {
      if (
        !(await operations.isRoutingEnabled("claude")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("claude"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      await routing.recordRouted(context.threadId, context.hostId);
      return [
        {
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: hubBasePath(bb.pluginId) },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
        {
          name: "ENABLE_TOOL_SEARCH",
          value: "true",
          reason:
            "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("claude-code", () =>
      proxiedHealth("claude"),
    );
    bb.providers.experimental_contributeEnv("codex", async (context) => {
      if (
        !(await operations.isRoutingEnabled("codex")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("codex"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      return [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: { serverPath: `${hubBasePath(bb.pluginId)}/v1` },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
      ];
    });
    bb.providers.experimental_contributeEnvHealth("codex", () =>
      proxiedHealth("codex"),
    );
    const openAiCompatibleRoutes: ReadonlyArray<{
      provider: PoolProvider;
      mountPrefix: string;
      providerId: string;
      keyEnv: string;
      baseUrlEnv: string;
    }> = [
      {
        provider: "zai",
        mountPrefix: ZAI_MOUNT_PREFIX,
        providerId: "acp-opencode-zai",
        keyEnv: "ZAI_API_KEY",
        baseUrlEnv: "OXI_ZAI_BASE_URL",
      },
      {
        provider: "opencode-go",
        mountPrefix: OPENCODE_GO_MOUNT_PREFIX,
        providerId: "acp-opencode-go",
        keyEnv: "OPENCODE_API_KEY",
        baseUrlEnv: "OXI_OPENCODE_GO_BASE_URL",
      },
    ];
    // Cursor's CLI exchanges its configured key for tokens before anything else. The hub
    // answers that itself instead of forwarding: it hands the machine back its own pool
    // token, so the real subscription credential never leaves this host, and every later
    // request arrives bearing a token the hub can recognise and swap for a minted one.
    bb.http.route(
      "POST",
      `/${CURSOR_MOUNT_PREFIX}${CURSOR_EXCHANGE_PATH}`,
      async (context) => {
        const hostId = await hub.authenticate(context.req.raw);
        if (hostId === null) {
          return Response.json(
            { error: { message: "Invalid Account Pooler bearer token.", code: 401 } },
            { status: 401 },
          );
        }
        const token = await hubTokens.forHost(hostId);
        return Response.json({ accessToken: token, refreshToken: token });
      },
      { auth: "none" },
    );
    for (const path of CURSOR_PROXIED_PATHS) {
      if (path === CURSOR_EXCHANGE_PATH) continue;
      for (const method of ["POST", "GET"] as const) {
        bb.http.route(
          method,
          `/${CURSOR_MOUNT_PREFIX}${path}`,
          (context) => hub.handle(context.req.raw, "cursor"),
          { auth: "none" },
        );
      }
    }
    // Only our wrapper entry, never the built-in `acp-cursor`. Cursor takes the address
    // of its agent stream from the server config it fetches, and only `--agent-endpoint`
    // outranks it — a flag the built-in agent cannot be given, because its launch
    // arguments are fixed in the ACP plugin and a plugin may contribute environment but
    // not arguments. Hand the built-in a hub token anyway and it opens that stream
    // straight at Cursor carrying a credential Cursor rejects: the session answers
    // "Please sign in to continue" while the pool reports perfect health. Left alone it
    // falls back to the machine's own Cursor login, which is a working session; the
    // pooled path is `acp-oxi-cursor`, which launches `cursor-route`.
    for (const cursorProviderId of ["acp-oxi-cursor"]) {
      bb.providers.experimental_contributeEnv(cursorProviderId, async (context) => {
      if (
        !(await operations.isRoutingEnabled("cursor")) ||
        (await routing.isBypassed(context.threadId)) ||
        !(await operations.hasUsableEnabledAccount("cursor"))
      ) {
        return [];
      }
      const token = await hubTokens.forHost(context.hostId);
      return [
        {
          name: "CURSOR_API_ENDPOINT",
          value: {
            serverPath: `${hubBasePath(bb.pluginId)}/${CURSOR_MOUNT_PREFIX}`.replace(
              /\/$/u,
              "",
            ),
          },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CURSOR_API_KEY",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
        {
          // Without this the CLI prefers a credential it already stored on the machine —
          // on a developer's own Mac that is a real Cursor login, which the hub cannot
          // authenticate, and the session dies at "Failed to initialize session services".
          // A pooled session must neither read nor write the machine's credential store.
          name: "AGENT_CLI_CREDENTIAL_STORE",
          value: "memory",
          reason: "Pooled session must ignore any credential stored on the machine",
        },
      ];
    });
      bb.providers.experimental_contributeEnvHealth(cursorProviderId, () =>
        proxiedHealth("cursor"),
      );
    }
    for (const entry of openAiCompatibleRoutes) {
      for (const route of ["chat/completions", "responses", "models"]) {
        bb.http.route(
          "POST",
          `/${entry.mountPrefix}v1/${route}`,
          (context) => hub.handle(context.req.raw, entry.provider),
          { auth: "none" },
        );
      }
      bb.providers.experimental_contributeEnv(
        entry.providerId,
        async (context) => {
          if (
            !(await operations.isRoutingEnabled(entry.provider)) ||
            (await routing.isBypassed(context.threadId)) ||
            !(await operations.hasUsableEnabledAccount(entry.provider))
          ) {
            return [];
          }
          const token = await hubTokens.forHost(context.hostId);
          return [
            {
              name: entry.baseUrlEnv,
              value: {
                serverPath: `${hubBasePath(bb.pluginId)}/${entry.mountPrefix}v1`,
              },
              reason: "Routed through the Account Pooler hub",
            },
            {
              name: entry.keyEnv,
              value: token,
              reason: "Account Pooler hub token for this machine",
            },
          ];
        },
      );
      bb.providers.experimental_contributeEnvHealth(entry.providerId, () =>
        proxiedHealth(entry.provider),
      );
    }
    for (const providerId of [
      "acp-opencode-kimi",
      "acp-opencode-kimi-highspeed",
    ]) {
      bb.providers.experimental_contributeEnv(providerId, async (context) => {
        if (
          !(await operations.isRoutingEnabled("kimi")) ||
          (await routing.isBypassed(context.threadId)) ||
          !(await operations.hasUsableEnabledAccount("kimi"))
        ) {
          return [];
        }
        const token = await hubTokens.forHost(context.hostId);
        return [
          {
            name: "OXI_KIMI_BASE_URL",
            value: {
              serverPath: `${hubBasePath(bb.pluginId)}/${KIMI_MOUNT_PREFIX}v1`,
            },
            reason: "Routed through the Account Pooler hub",
          },
          {
            name: "KIMI_API_KEY",
            value: token,
            reason: "Account Pooler hub token for this machine",
          },
        ];
      });
      bb.providers.experimental_contributeEnvHealth(providerId, () =>
        proxiedHealth("kimi"),
      );
    }
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    bb.http.route(
      "POST",
      "/v1/messages",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    bb.http.route(
      "POST",
      "/v1/messages/count_tokens",
      (context) => hub.handle(context.req.raw, "claude"),
      { auth: "none" },
    );
    for (const route of [
      "/v1/responses",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "codex"),
        { auth: "none" },
      );
    }
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex"),
      { auth: "none" },
    );
    for (const route of [
      `/${KIMI_MOUNT_PREFIX}v1/messages`,
      `/${KIMI_MOUNT_PREFIX}v1/messages/count_tokens`,
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "kimi"),
        { auth: "none" },
      );
    }
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: (signal) => hub.start(signal),
    });
  };
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
