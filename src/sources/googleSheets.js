import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseCsvMatrix, matrixToObjects } from "../parsers/csvParser.js";

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Obtains a Google OAuth2 access token using a Service Account JSON (RS256 JWT).
 */
export async function getGoogleAccessToken(serviceAccount, fetchFn = fetch) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })
  );

  const signingInput = `${header}.${claimSet}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = base64UrlEncode(signer.sign(serviceAccount.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google OAuth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.access_token;
}

function loadServiceAccount(googleSheetsConfig, cwd) {
  if (googleSheetsConfig.serviceAccountJson) {
    return JSON.parse(googleSheetsConfig.serviceAccountJson);
  }
  if (googleSheetsConfig.serviceAccountPath) {
    const fullPath = path.resolve(cwd, googleSheetsConfig.serviceAccountPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Google Service Account file not found: ${fullPath}`);
    }
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  }
  return null;
}

/**
 * Fetches sheet rows from either:
 *  1) local CSV file (`localFilePath`)
 *  2) Google Sheets API v4 (Service Account)
 *  3) Public Google Sheets CSV export URL
 */
export async function fetchSheetRows(config, { localFilePath = null, fetchFn = fetch } = {}) {
  if (localFilePath) {
    const resolved = path.resolve(config.cwd, localFilePath);
    const csv = fs.readFileSync(resolved, "utf8");
    return matrixToObjects(parseCsvMatrix(csv));
  }

  const gs = config.googleSheets;
  const serviceAccount = loadServiceAccount(gs, config.cwd);

  if (serviceAccount) {
    if (!gs.sheetId) {
      throw new Error("GOOGLE_SHEET_ID is required when using a Google Service Account.");
    }
    const token = await getGoogleAccessToken(serviceAccount, fetchFn);
    const rangeEnc = encodeURIComponent(gs.range || "Sheet1!A1:Z");
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(gs.sheetId)}/values/${rangeEnc}`;
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google Sheets API error (${res.status}): ${body}`);
    }
    const payload = await res.json();
    return matrixToObjects(payload.values || []);
  }

  const gidsToFetch =
    Array.isArray(gs.gids) && gs.gids.length > 0
      ? gs.gids
      : gs.csvUrl
        ? [null]
        : gs.sheetId
          ? [gs.gid || "0"]
          : [];

  if (gidsToFetch.length === 0) {
    throw new Error(
      "No Google Sheets source configured. Set GOOGLE_SERVICE_ACCOUNT_PATH + GOOGLE_SHEET_ID, or GOOGLE_SHEET_CSV_URL, or pass --file=<path.csv>."
    );
  }

  const allRows = [];
  for (const gid of gidsToFetch) {
    const csvUrl =
      gid === null
        ? gs.csvUrl
        : `https://docs.google.com/spreadsheets/d/${encodeURIComponent(gs.sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;

    const res = await fetchFn(csvUrl);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch Google Sheet CSV (${res.status}): ${body}`);
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const csvText = await res.text();
    if (contentType.includes("text/html") || /^\s*<!doctype html/i.test(csvText)) {
      throw new Error(
        "Google Sheet is private (returned HTML login page instead of CSV). Either share the sheet as 'Anyone with the link -> Viewer', or configure a Google Service Account in .env (GOOGLE_SERVICE_ACCOUNT_PATH), or export a local CSV and pass --file=path.csv."
      );
    }
    const tabRows = matrixToObjects(parseCsvMatrix(csvText));
    for (const r of tabRows) {
      if (gid !== null) r.__sheetGid = gid;
      allRows.push(r);
    }
  }
  return allRows;
}
