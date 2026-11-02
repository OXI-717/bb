import { describe, expect, it } from "vitest";
import type { SystemProviderState } from "@bb/server-contract";
import { providerReadinessOption } from "./provider-readiness";

function state(
  status: SystemProviderState["status"],
  statusMessage: string | null = null,
): SystemProviderState {
  return {
    providerId: "pooled",
    displayName: "Pooled",
    status,
    statusMessage,
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
    localLoginCommand: null,
  };
}

describe("providerReadinessOption", () => {
  it("refuses unchecked or missing providers instead of trusting installation", () => {
    expect(providerReadinessOption("pooled", undefined).disabled).toBe(true);
    expect(providerReadinessOption("pooled", []).disabled).toBe(true);
  });
  it("recovers after a periodic check without changing another selection", () => {
    expect(
      providerReadinessOption("pooled", [state("unknown", "Quota exhausted")]),
    ).toEqual({ disabled: true, disabledReason: "Quota exhausted" });
    expect(providerReadinessOption("pooled", [state("ready")])).toEqual({
      disabled: false,
    });
  });
  it.each([
    "not_installed",
    "unauthenticated",
    "expired",
    "unsupported_version",
    "unknown",
  ] as const)("does not offer %s as usable", (status) => {
    expect(providerReadinessOption("pooled", [state(status)]).disabled).toBe(
      true,
    );
  });
});
