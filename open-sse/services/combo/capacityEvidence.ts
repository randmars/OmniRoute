/** Validate provider timestamps before they can schedule a capacity recovery. */
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;

export function parseVerifiedInstant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const match = ISO_INSTANT.exec(value);
  if (!match) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  return new Date(parsed).toISOString() === canonical ? parsed : NaN;
}
