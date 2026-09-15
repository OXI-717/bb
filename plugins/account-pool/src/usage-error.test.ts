import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "./codex-adapter.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("usage refresh", () => {
  it("clears a stale account error once the usage endpoint answers", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-usage-"),
    );
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const accounts = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await accounts.initialize();
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
    const quotas = new QuotaStore(db);
    const secret = {
      kind: "oauth" as const,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: null,
    };
    const account = await accounts.add(
      {
        provider: "codex",
        kind: "oauth",
        label: "codex",
        email: null,
        accountUuid: null,
        codexAccountId: "chatgpt-account",
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
      },
      secret,
    );
    quotas.put({ ...quotas.get(account.id), error: "upstream blocked" });
    const adapter = createCodexAdapter({
      refreshUrl: "https://auth.example/oauth/token",
      usageUrl: "https://usage.example/wham/usage",
    });
    const refresh = (status: number) =>
      adapter.refreshUsage({
        account,
        accounts,
        quotas,
        now: () => 1_800_000_000_000,
        freshSecret: async () => secret,
        fetch: async () =>
          Response.json(
            {
              plan_type: "pro",
              rate_limit: {
                primary_window: {
                  used_percent: 40,
                  reset_after_seconds: 3_600,
                },
              },
            },
            { status },
          ),
      });

    await refresh(503);
    expect(quotas.get(account.id).error).toBe("upstream blocked");
    await refresh(200);
    expect(quotas.get(account.id)).toMatchObject({
      error: null,
      limitWindows: [expect.objectContaining({ utilization: 0.4 })],
    });
  });
});
