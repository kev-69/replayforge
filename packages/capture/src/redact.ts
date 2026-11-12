import type { CapturedBody, HeaderMap } from "@replayforge/core";

/**
 * Redaction: replace sensitive values before they are written to disk.
 *
 * The trade-off: a redacted value can't be replayed. If you redact the
 * Authorization header, replayed requests arrive unauthenticated. That's why
 * the defaults below only cover cookies, and the docs (docs/architecture.md)
 * explain how to choose.
 */

export const REDACTED = "[REDACTED]";

export const DEFAULT_REDACT_HEADERS = ["cookie", "set-cookie", "proxy-authorization"];

/** Returns a copy of `headers` with the listed header names redacted (case-insensitive). */
export function redactHeaders(
  headers: HeaderMap,
  names: ReadonlySet<string>,
  pathPrefix: string,
  redactions: string[],
): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (names.has(name.toLowerCase())) {
      out[name] = Array.isArray(value) ? value.map(() => REDACTED) : REDACTED;
      redactions.push(`${pathPrefix}.${name}`);
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Redacts JSON fields by name, at any depth (e.g. "password" also matches
 * `{ "user": { "password": ... } }`).
 *
 * Only complete text bodies that parse as JSON are touched. When something is
 * redacted the body is re-serialized, so its exact formatting is lost. That's
 * fine, because a redacted body isn't byte-identical to the original anyway.
 */
export function redactJsonBody(
  body: CapturedBody,
  fields: ReadonlySet<string>,
  pathPrefix: string,
  redactions: string[],
): CapturedBody {
  if (fields.size === 0 || body.kind !== "text" || body.truncated) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.data);
  } catch {
    return body; // not JSON: leave it alone
  }

  const before = redactions.length;
  const redacted = walk(parsed, pathPrefix);
  if (redactions.length === before) return body; // nothing matched: keep the original bytes
  return { ...body, data: JSON.stringify(redacted) };

  function walk(value: unknown, path: string): unknown {
    if (Array.isArray(value)) return value.map((item, i) => walk(item, `${path}[${i}]`));
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (fields.has(key.toLowerCase())) {
        out[key] = REDACTED;
        redactions.push(childPath);
      } else {
        out[key] = walk(child, childPath);
      }
    }
    return out;
  }
}

export function toLowerSet(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.map((n) => n.toLowerCase()));
}
