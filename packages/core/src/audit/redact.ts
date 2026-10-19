// Keys are matched on whole words of the key (snake_case, kebab-case or camelCase), so
// "pan_number" and "clientSecret" are redacted but "company" (which contains "pan") is not.
const SENSITIVE_WORD = /(?:^|_)(password|passphrase|passwd|secret|token|api_?key|credentials?|authorization|cookie|aadhaar|otp|pan|pan_?(?:no|number))$/;

export function isSensitiveKey(key: string): boolean {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
  return SENSITIVE_WORD.test(snake);
}

export function redactString(value: string): string {
  return value
    .replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d][A-Z][A-Z\d]\b/g, (m) => mask(m))
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, (m) => mask(m))
    .replace(/\b(?:\d[ -]?){12,19}\b/g, (m) => {
      const digits = m.replace(/[ -]/g, "");
      // Card numbers pass Luhn; Aadhaar numbers are 12 digits and pass Verhoeff. Other long
      // numbers (Zoho record ids, voucher ids) are left intact so the audit stays useful.
      if ((digits.length >= 13 && luhnValid(digits)) || (digits.length === 12 && verhoeffValid(digits))) return mask(digits);
      return m;
    });
}

function mask(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i++) c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return "[max-depth]" as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? "[redacted]" : redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
