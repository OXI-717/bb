import { describe, expect, it } from "vitest";
import { parseCreatePresets } from "./create-presets.js";
import { createPresetsSettingSchema } from "./create-presets-schema.js";

const preset = {
  label: "Team server",
  description: "Create remotely",
  prompt: "Use the team CLI\n\nTask: ",
};
describe("creation presets", () => {
  it("preserves the remote instruction without a local automation prefix", () => {
    expect(parseCreatePresets(JSON.stringify([preset]))).toEqual([preset]);
  });
  it("rejects malformed, duplicate and excessive entries at the settings boundary", () => {
    for (const value of [
      "{",
      "null",
      JSON.stringify([preset, preset]),
      JSON.stringify(
        Array.from({ length: 21 }, (_, index) => ({
          ...preset,
          label: String(index),
        })),
      ),
      JSON.stringify([{ ...preset, command: "shell" }]),
      JSON.stringify([{ ...preset, prompt: "" }]),
    ]) {
      expect(createPresetsSettingSchema.safeParse(value).success).toBe(false);
      expect(parseCreatePresets(value)).toEqual([]);
    }
  });
});
