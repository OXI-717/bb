import type { SystemProviderState } from "@bb/server-contract";

export function providerReadinessOption(
  providerId: string,
  states: readonly SystemProviderState[] | undefined,
): { disabled: boolean; disabledReason?: string } {
  const state = states?.find((entry) => entry.providerId === providerId);
  if (state?.status === "ready") return { disabled: false };
  return {
    disabled: true,
    disabledReason:
      state?.statusMessage ??
      (states === undefined
        ? "Checking readiness on this machine."
        : "Provider readiness is not confirmed on this machine."),
  };
}
