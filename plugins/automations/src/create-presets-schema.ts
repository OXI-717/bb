import { z } from "zod";
import { readCreatePresets } from "./create-presets.js";

export const createPresetsSettingSchema = z.string().refine((value) => {
  try {
    readCreatePresets(value);
    return true;
  } catch {
    return false;
  }
}, "Expected up to 20 unique creation presets with label, description and prompt");
