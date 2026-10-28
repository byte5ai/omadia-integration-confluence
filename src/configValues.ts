/**
 * Setup-value readers that accept BOTH shapes a stored value can have
 * (byte5ai/omadia#1478):
 *
 * - typed — since 0.3.4 the manifest declares `boolean` / `integer` fields, so
 *   the host stores `true` / `200000`;
 * - legacy strings — installs configured before 0.3.4 keep `"true"` /
 *   `"200000"` in their stored config; the host validates types at install
 *   time only, so those strings stay until the operator saves again.
 *
 * An unreadable value falls back to the default, but never silently: the
 * caller's `warn` gets the key and the raw value.
 */

export type Warn = (message: string) => void;

export function readBoolean(
  key: string,
  raw: unknown,
  fallback: boolean,
  warn: Warn,
): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  warn(
    `[confluence] ${key}=${JSON.stringify(raw)} is not true/false — using default ${String(fallback)}`,
  );
  return fallback;
}

export function readPositiveInt(
  key: string,
  raw: unknown,
  fallback: number,
  warn: Warn,
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  if (Number.isInteger(n) && n > 0) return n;
  warn(
    `[confluence] ${key}=${JSON.stringify(raw)} is not a positive integer — using default ${String(fallback)}`,
  );
  return fallback;
}
