export const MAX_CONTENT_LENGTH = 10_240;

export function truncate(value: unknown): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return str.length > MAX_CONTENT_LENGTH ? str.slice(0, MAX_CONTENT_LENGTH) : str;
  } catch {
    return "[unserializable]";
  }
}
