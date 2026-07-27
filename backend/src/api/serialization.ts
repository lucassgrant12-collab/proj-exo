/** JSON has no bigint type, and this codebase deliberately uses bigint
 * everywhere for money (see domain/money.ts). Route handlers should pass
 * response payloads through this before returning them, rather than relying
 * on any global JSON.stringify patching — explicit is safer than magic for
 * a codebase where getting money serialization wrong is a real bug class. */
export function serializeBigInts<T>(value: T): T {
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map(serializeBigInts) as unknown as T;
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeBigInts(v);
    }
    return out as T;
  }
  return value;
}
