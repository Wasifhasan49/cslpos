/**
 * Getting serial numbers into the computer without typing each one.
 *
 * A delivery of 50 SSDs is 50 serials. BMS offers three ways and so does this: scan
 * them one after another (the scanner sends Enter), paste a block, or give a range when
 * they are sequential. The last one is where the mistakes happen, so it is a pure
 * function with tests rather than something assembled in an event handler.
 */

export interface SerialProblem {
  serial: string;
  why: string;
}

export interface SerialCheck {
  /** Trimmed, de-duplicated, in the order given. */
  serials: string[];
  problems: SerialProblem[];
}

/**
 * Expand a from–to range, with the leading part held constant.
 *
 * "SN0098" to "SN0102" gives SN0098…SN0102, keeping the zero padding. The numeric tail
 * is what counts up; the prefix must match, because counting from "SNA001" to "SNB003"
 * is not a range, it is two ranges and a guess.
 */
export function expandSerialRange(from: string, to: string, maxCount = 500): SerialCheck {
  const a = from.trim();
  const b = to.trim();
  if (a === "" || b === "") {
    return { serials: [], problems: [{ serial: `${a}–${b}`, why: "Give both a first and a last serial." }] };
  }

  const tail = /^(.*?)(\d+)$/;
  const ma = tail.exec(a);
  const mb = tail.exec(b);
  if (!ma || !mb) {
    return { serials: [], problems: [{ serial: `${a}–${b}`, why: "A range needs serials that end in digits." }] };
  }

  const [, prefixA, digitsA] = ma;
  const [, prefixB, digitsB] = mb;
  if (prefixA !== prefixB) {
    return {
      serials: [],
      problems: [{ serial: `${a}–${b}`, why: `These don't share a start: "${prefixA}" and "${prefixB}".` }],
    };
  }

  const start = Number(digitsA);
  const end = Number(digitsB);
  if (end < start) {
    return { serials: [], problems: [{ serial: `${a}–${b}`, why: "The last serial is lower than the first." }] };
  }

  const count = end - start + 1;
  if (count > maxCount) {
    return {
      serials: [],
      problems: [{ serial: `${a}–${b}`, why: `That is ${count} serials. Do it in batches of ${maxCount} or fewer.` }],
    };
  }

  // Keep the padding the first serial used, so SN0098 counts to SN0102 and not SN102.
  const width = digitsA.length;
  const serials: string[] = [];
  for (let n = start; n <= end; n++) {
    serials.push(`${prefixA}${String(n).padStart(width, "0")}`);
  }
  return { serials, problems: [] };
}

/**
 * Pull serials out of pasted text or a scanned QR code.
 *
 * Split on anything a human or a scanner might separate them with: newlines, commas,
 * semicolons, tabs, pipes. Spaces are NOT separators, because some serials contain them.
 */
export function parseSerialList(text: string): string[] {
  return text
    .split(/[\n\r,;|\t]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export interface CheckOptions {
  /** Serials already on this line, or elsewhere in this delivery. */
  alreadyHere?: string[];
  /** Serials the shop already knows about, from any earlier delivery. */
  alreadyKnown?: Set<string>;
  /** The product's expected serial length, if it has one (BMS "Digit check"). */
  expectedLength?: number | null;
  /** A pattern the serial must match. */
  pattern?: string | null;
}

/**
 * Check a batch of serials before anything is saved.
 *
 * Everything is caught here as well as in the database. The database is the real guard,
 * but discovering a mis-scan after pressing Save means re-scanning fifty serials.
 */
export function checkSerials(input: string[], options: CheckOptions = {}): SerialCheck {
  const { alreadyHere = [], alreadyKnown, expectedLength, pattern } = options;
  const seen = new Set(alreadyHere.map((s) => s.trim()));
  const serials: string[] = [];
  const problems: SerialProblem[] = [];
  const re = pattern ? safeRegex(pattern) : null;

  for (const raw of input) {
    const s = raw.trim();
    if (s === "") continue;

    if (seen.has(s)) {
      problems.push({ serial: s, why: "Already scanned for this delivery." });
      continue;
    }
    if (alreadyKnown?.has(s)) {
      problems.push({ serial: s, why: "The shop already has this serial." });
      continue;
    }
    if (expectedLength != null && s.length !== expectedLength) {
      problems.push({
        serial: s,
        why: `This product's serials are ${expectedLength} characters; that one is ${s.length}.`,
      });
      continue;
    }
    if (re && !re.test(s)) {
      problems.push({ serial: s, why: "Doesn't look like this product's serials." });
      continue;
    }

    seen.add(s);
    serials.push(s);
  }

  return { serials, problems };
}

/** A pattern from the shop's own settings, so a bad one must not throw mid-scan. */
function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Make up serials for items that arrived without any (BMS "A.G Serial").
 *
 * Shop-made serials are marked so nobody later mistakes one for the manufacturer's:
 * the prefix, the date and a counter.
 */
export function generateSerials(prefix: string, count: number, startAt = 1, today = new Date()): string[] {
  const stamp = today.toISOString().slice(2, 10).replace(/-/g, "");
  const clean = prefix.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "SHOP";
  return Array.from({ length: Math.max(count, 0) }, (_, i) =>
    `${clean}-${stamp}-${String(startAt + i).padStart(4, "0")}`,
  );
}
