export interface CreationPreset {
  label: string;
  description: string;
  prompt: string;
}

export function readCreatePresets(value: string): CreationPreset[] {
  if (value.length > 180000) throw new Error("Creation presets are too large");
  const entries: unknown = JSON.parse(value);
  if (!Array.isArray(entries) || entries.length > 20) {
    throw new Error("Expected up to 20 creation presets");
  }
  const labels = new Set<string>();
  return entries.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("label" in entry) ||
      !("description" in entry) ||
      !("prompt" in entry) ||
      Object.keys(entry).length !== 3
    ) {
      throw new Error("Expected label, description and prompt");
    }
    const { label, description, prompt } = entry;
    if (
      typeof label !== "string" ||
      typeof description !== "string" ||
      typeof prompt !== "string" ||
      !label.trim() ||
      label.trim().length > 80 ||
      !description.trim() ||
      description.trim().length > 240 ||
      !prompt.trim() ||
      prompt.length > 8000 ||
      labels.has(label.trim())
    ) {
      throw new Error("Invalid or duplicate creation preset");
    }
    labels.add(label.trim());
    return {
      label: label.trim(),
      description: description.trim(),
      prompt,
    };
  });
}

export function parseCreatePresets(value: unknown): CreationPreset[] {
  if (typeof value !== "string") return [];
  try {
    return readCreatePresets(value);
  } catch {
    return [];
  }
}
