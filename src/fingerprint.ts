import { createHash } from 'node:crypto';

export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return item;
  });
  if (json === undefined) throw new Error('Cannot fingerprint an empty value');
  return createHash('sha256').update(json).digest('hex');
}
