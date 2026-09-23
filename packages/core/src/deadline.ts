export const DEADLINE_HEADER = "x-hyapi-deadline";

export function parseDeadlineHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return undefined;
  return Number(trimmed);
}
