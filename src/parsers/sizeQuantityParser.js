const EMPTY_MARKERS = new Set(["", "-", "—", "–", "none", "null", "нет", "немає", "n/a"]);

const CYRILLIC_TO_LATIN_SIZE_MAP = {
  А: "A",
  В: "B",
  Е: "E",
  І: "I",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
};

/**
 * Normalizes size codes (uppercases and converts Cyrillic lookalike letters like "М" -> "M").
 */
export function normalizeSizeCode(size) {
  return String(size || "")
    .trim()
    .toUpperCase()
    .replace(/[АВЕІКМНОРСТХ]/g, (ch) => CYRILLIC_TO_LATIN_SIZE_MAP[ch] || ch);
}

function isPureSizeToken(token) {
  return /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL|5XL|OS|ON|ONE\s*SIZE|[A-ZА-ЯІЇЄҐ][A-Z0-9А-ЯІЇЄҐ/_-]*)$/i.test(
    token
  );
}

/**
 * Parses a cell containing combined size + quantity tokens such as:
 *   "1XS 1S" -> [{ size: "XS", quantity: 1 }, { size: "S", quantity: 1 }]
 *   "4-XS 3-S 4-M" -> [{ size: "XS", quantity: 4 }, { size: "S", quantity: 3 }, { size: "M", quantity: 4 }]
 *   "1XS 1S 3М" (Cyrillic М) -> [{ size: "XS", quantity: 1 }, { size: "S", quantity: 1 }, { size: "M", quantity: 3 }]
 *   "2M, 3L" -> [{ size: "M", quantity: 2 }, { size: "L", quantity: 3 }]
 *   "1 2XL 2 S" -> [{ size: "2XL", quantity: 1 }, { size: "S", quantity: 2 }]
 *   "XS:1 S:2" -> [{ size: "XS", quantity: 1 }, { size: "S", quantity: 2 }]
 *   "5" -> [{ size: null, quantity: 5 }]
 *
 * Returns { entries: Array<{ size: string | null, quantity: number }>, errors: string[] }.
 */
export function parseSizeQuantities(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return { entries: [], errors: [] };
  }

  const trimmed = String(rawValue).trim();
  if (EMPTY_MARKERS.has(trimmed.toLowerCase())) {
    return { entries: [], errors: [] };
  }

  // Plain numeric stock (product without size breakdown)
  if (/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
    const qty = Number(trimmed.replace(",", "."));
    return { entries: [{ size: null, quantity: qty }], errors: [] };
  }

  const rawTokens = trimmed
    .replace(/\r?\n/g, " ")
    .split(/[\s,;]+/)
    .map((t) => t.trim().replace(/[-–—]+$/, ""))
    .filter(Boolean);

  const aggregated = new Map();
  const errors = [];

  const addEntry = (sizeKey, qty) => {
    if (!Number.isFinite(qty) || qty < 0) {
      errors.push(`Invalid quantity for size "${sizeKey}": ${qty}`);
      return;
    }
    const normalizedKey = sizeKey === null ? null : normalizeSizeCode(sizeKey);
    aggregated.set(normalizedKey, (aggregated.get(normalizedKey) || 0) + qty);
  };

  for (let i = 0; i < rawTokens.length; i++) {
    const token = rawTokens[i];

    // Pattern 1: "XS:1" or "XS=1" or "2XL:3"
    const kvMatch = token.match(/^([A-Za-zА-Яа-яІіЇїЄєҐґ0-9/_-]+)[:=](\d+(?:[.,]\d+)?)$/);
    if (kvMatch) {
      addEntry(kvMatch[1], Number(kvMatch[2].replace(",", ".")));
      continue;
    }

    // Pattern 2a: "1-XS", "4-XS", "7-S", "1*XS"
    const sepMultMatch = token.match(/^(\d+(?:[.,]\d+)?)[-–—*]([A-Za-zА-Яа-яІіЇїЄєҐґ0-9/_-]+)$/);
    if (sepMultMatch) {
      addEntry(sepMultMatch[2], Number(sepMultMatch[1].replace(",", ".")));
      continue;
    }

    // Pattern 2b: "1x2XL", "1x42"
    const digitMultMatch = token.match(/^(\d+(?:[.,]\d+)?)[xх](\d+[A-Za-zА-Яа-яІіЇїЄєҐґ0-9/_-]*)$/i);
    if (digitMultMatch) {
      addEntry(digitMultMatch[2], Number(digitMultMatch[1].replace(",", ".")));
      continue;
    }

    // Pattern 2c: case-sensitive "1xM", "2xS", "1xL"
    const lowerXSingleMatch = token.match(/^(\d+(?:[.,]\d+)?)[xх]([SML])$/);
    if (lowerXSingleMatch) {
      addEntry(lowerXSingleMatch[2], Number(lowerXSingleMatch[1].replace(",", ".")));
      continue;
    }

    // Pattern 3: compact "<qty><size>" like "1XS", "1S", "3М", "4OS"
    const compactMatch = token.match(/^(\d+(?:[.,]\d+)?)([A-Za-zА-Яа-яІіЇїЄєҐґ][A-Za-zА-Яа-яІіЇїЄєҐґ0-9/_-]*)$/);
    if (compactMatch) {
      addEntry(compactMatch[2], Number(compactMatch[1].replace(",", ".")));
      continue;
    }

    // Pattern 4: separated by space: "1" followed by pure size like "2XL", "XS", "S" (NOT followed by "1M")
    if (/^\d+(?:[.,]\d+)?$/.test(token)) {
      const next = rawTokens[i + 1];
      const nextIsKnownSizedWithDigit = /^(?:2XL|3XL|4XL|5XL)$/i.test(next || "");
      if (
        next &&
        isPureSizeToken(next) &&
        (nextIsKnownSizedWithDigit || !/^\d+[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(next))
      ) {
        addEntry(next, Number(token.replace(",", ".")));
        i++;
        continue;
      }
      // Standalone number alongside other tokens (e.g. "3 1M"): treat as unsized base stock
      addEntry(null, Number(token.replace(",", ".")));
      continue;
    }

    // Pattern 5: "XS:" followed by "1"
    const prefixSepMatch = token.match(/^([A-Za-zА-Яа-яІіЇїЄєҐґ0-9/_-]+)[:=]$/);
    if (prefixSepMatch && i + 1 < rawTokens.length && /^\d+(?:[.,]\d+)?$/.test(rawTokens[i + 1])) {
      addEntry(prefixSepMatch[1], Number(rawTokens[i + 1].replace(",", ".")));
      i++;
      continue;
    }

    errors.push(`Unrecognized size/quantity token "${token}" in "${trimmed}"`);
  }

  const entries = [...aggregated.entries()].map(([size, quantity]) => ({ size, quantity }));
  return { entries, errors };
}

/**
 * Builds variant SKU from base SKU and optional size using pattern (e.g. "{baseSku}-{size}").
 */
export function buildVariantSku(baseSku, size, skuPattern = "{baseSku}-{size}") {
  const cleanBase = String(baseSku || "").trim();
  if (!size) return cleanBase;
  return skuPattern
    .replace(/\{baseSku\}/g, cleanBase)
    .replace(/\{size\}/g, String(size).trim());
}
