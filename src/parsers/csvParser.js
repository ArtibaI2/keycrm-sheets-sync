/**
 * Parses RFC 4180 CSV text (handles UTF-8 BOM, quoted fields, escaped quotes, CRLF/LF)
 * into a 2D array of strings.
 */
export function parseCsvMatrix(csvText, delimiter = null) {
  const clean = String(csvText || "").replace(/^\uFEFF/, "");
  if (!clean.trim()) return [];

  const sep = delimiter || detectDelimiter(clean);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && next === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  return semicolons > commas ? ";" : ",";
}

/**
 * Converts a 2D table matrix (first row = headers) into an array of row objects
 * with trimmed header keys plus `__col0`, `__col1`, ... for unnamed columns.
 */
export function matrixToObjects(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 2) return [];
  const headers = matrix[0].map((h) => String(h || "").trim());
  const result = [];

  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || !row.some((v) => String(v || "").trim() !== "")) continue;
    const obj = { __rowNumber: r + 1 };
    const colCount = Math.max(headers.length, row.length);
    for (let c = 0; c < colCount; c++) {
      const val = row[c] !== undefined ? String(row[c]).trim() : "";
      obj[`__col${c}`] = val;
      const header = headers[c];
      if (header) {
        obj[header] = val;
      }
    }
    result.push(obj);
  }

  return result;
}
