const SENSITIVE_KEY_PATTERN = /pass(word|phrase)?|secret|token|api[_-]?key|credential|authorization|cookie|aadhaar|pan(_?number)?|otp/i;

export function redactString(value: string): string {
  return value
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z\d]\b/g, (m) => mask(m))
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, (m) => mask(m))
    .replace(/\b(?:\d[ -]?){12,19}\b/g, (m) => mask(m.replace(/[ -]/g, "")));
}

function mask(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return "[max-depth]" as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[redacted]" : redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
