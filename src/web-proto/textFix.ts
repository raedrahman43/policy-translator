/**
 * textFix — repair "mojibake" text on ingest.
 *
 * When analyzer JSON (or branding text) is copied through a tool that decodes
 * UTF-8 bytes as Windows-1252/Latin-1, characters like the em dash "—" arrive
 * as the 3-char sequence "â€"". Our engine and server are UTF-8 clean, but we
 * cannot control what a customer pastes — so we heal common corruption here,
 * once, at the edge. The generated scripts/gap report then render correctly.
 *
 * Approach (the classic "ftfy" round-trip): if a string shows a mojibake
 * signature, reverse it by mapping each character back to the Windows-1252 byte
 * it came from and decoding those bytes as UTF-8. Only applied when the string
 * looks corrupted AND the repaired result is valid UTF-8, so clean input
 * (including legitimate em dashes or emoji) is never touched.
 */

// Windows-1252 high range (0x80–0x9F) — the bytes that differ from Latin-1.
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

// Reverse map: Unicode code point → the Windows-1252 byte that decodes to it.
const UNI_TO_CP1252 = new Map<number, number>();
for (let b = 0; b <= 0xff; b++) {
  const high = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b] : undefined;
  const cp = high ?? b;
  if (!UNI_TO_CP1252.has(cp)) UNI_TO_CP1252.set(cp, b);
}

// Telltale signs of UTF-8-as-CP1252 corruption (Ã…, â€¦, Â …).
const MOJIBAKE_SIGNATURE = /[ÂÃ][\u0080-\u00bf\u2013\u2014\u2018\u2019\u201c\u201d\u2020\u2022\u2026\u2039\u203a\u20ac\u2122]|â€|â†|âœ|âš/;

/** Repair a single string if it shows mojibake; otherwise return it unchanged. */
export function repairMojibake(s: string): string {
  if (!s || !MOJIBAKE_SIGNATURE.test(s)) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const b = UNI_TO_CP1252.get(cp);
    // A character that has no Windows-1252 byte (e.g. a real emoji) means this
    // isn't uniformly this kind of mojibake — leave the string untouched.
    if (b === undefined) return s;
    bytes.push(b);
  }
  try {
    const decoded = Buffer.from(bytes).toString("utf8");
    if (decoded.includes("\ufffd")) return s; // not valid UTF-8 → not mojibake
    return decoded;
  } catch {
    return s;
  }
}

/** Recursively repair mojibake in every string within an object/array/string. */
export function deepRepairMojibake<T>(value: T): T {
  if (typeof value === "string") return repairMojibake(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepRepairMojibake(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRepairMojibake(v);
    }
    return out as unknown as T;
  }
  return value;
}
