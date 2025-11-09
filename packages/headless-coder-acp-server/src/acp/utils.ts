export function jsonl(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}
