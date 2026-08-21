export type JsonSchemaParameters = {
  type: "object";
  properties: Record<
    string,
    {
      type: string;
      description: string;
      enum?: string[];
    }
  >;
  required?: string[];
};

export type AgentTool = {
  name: string;
  description: string;
  parameters: JsonSchemaParameters;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
};

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asInteger(value: unknown, fallback: number): number {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
}
