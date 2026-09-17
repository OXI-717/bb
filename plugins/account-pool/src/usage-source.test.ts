import { describe, expect, it } from "vitest";
import { usagePlanLabel, usageWindowLabel,
  USAGE_PROVIDER_IDS,
} from "./usage-source.js";

describe("usage presentation labels", () => {
  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
  });
  it("retains known Max multipliers without inventing a missing tier", () => {
    expect(
      usagePlanLabel({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toBe("Max (20x)");
    expect(
      usagePlanLabel({ subscriptionType: "max", rateLimitTier: null }),
    ).toBe("Max");
    expect(
      usagePlanLabel({ subscriptionType: "pro", rateLimitTier: null }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({ subscriptionType: null, rateLimitTier: null }),
    ).toBeNull();
  });
});

describe("pooled providers on the usage surface", () => {
  it("names a BB provider for every pooled subscription", () => {
    // The map is exhaustive by type, but the values are ours: a wrong id puts the
    // subscription's windows under someone else's card, or under none at all.
    expect(USAGE_PROVIDER_IDS).toEqual({
      claude: "claude-code",
      codex: "codex",
      kimi: "acp-opencode-kimi",
      zai: "acp-opencode-zai",
      "opencode-go": "acp-opencode-go",
      cursor: "acp-oxi-cursor",
    });
    expect(new Set(Object.values(USAGE_PROVIDER_IDS)).size).toBe(
      Object.keys(USAGE_PROVIDER_IDS).length,
    );
  });
});
