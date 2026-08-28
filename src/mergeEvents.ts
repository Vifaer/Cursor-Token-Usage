import { UsageEvent } from "./models";

export function eventKey(e: UsageEvent): string {
  return `${e.timestamp}|${e.model}|${e.kind}`;
}

export function mergeEvents(existing: UsageEvent[], incoming: UsageEvent[]): UsageEvent[] {
  const seen = new Set(existing.map(eventKey));
  const extras = incoming.filter((e) => !seen.has(eventKey(e)));
  if (extras.length === 0) return existing;
  return [...extras, ...existing];
}
