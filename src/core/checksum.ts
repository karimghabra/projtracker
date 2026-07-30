/**
 * A cheap, stable fingerprint of a string.
 *
 * Used by the backup, where the question is never "did somebody forge this"
 * but "did a spreadsheet quietly trim a trailing space, convert something that
 * looked like a date, or drop half a cell". FNV-1a catches all of that, is
 * fifteen lines, and needs no dependency — which, after shipping 38MB of
 * node_modules once, is the deciding argument.
 *
 * 64 bits via BigInt rather than the usual 32: a restore that silently applies
 * corrupted data is the one failure mode worth spending arithmetic on, and the
 * inputs are vault files, not video.
 */

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** Sixteen lowercase hex digits. Identical input always gives identical output. */
export function checksum(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}
