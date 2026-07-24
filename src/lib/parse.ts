"use client";
import Papa from "papaparse";
import { CrawlRow, CrawlRowSchema, GscRow } from "./schema";

/** Header aliases → normalized field. Tolerant to Screaming Frog version drift. */
const HEADER_MAP: Record<string, keyof CrawlRow> = {
  address: "url",
  url: "url",
  "status code": "statusCode",
  indexability: "indexability",
  "indexability status": "indexabilityStatus",
  "title 1": "title",
  title: "title",
  "title 1 length": "titleLength",
  "meta description 1": "metaDescription",
  "meta description 1 length": "metaLength",
  "h1-1": "h1",
  "h1-2": "h1Second",
  "h2-1": "h2",
  "canonical link element 1": "canonical",
  "meta robots 1": "metaRobots",
  "word count": "wordCount",
  "crawl depth": "crawlDepth",
  inlinks: "inlinks",
  "unique inlinks": "inlinks",
  outlinks: "outlinks",
  "unique outlinks": "outlinks",
  "response time": "responseTime",
  "content type": "contentType",
  "redirect url": "redirectUrl",
  "redirect uri": "redirectUrl",
  "redirect type": "redirectType",
};

const NUMERIC_FIELDS = new Set<keyof CrawlRow>([
  "statusCode",
  "titleLength",
  "metaLength",
  "wordCount",
  "crawlDepth",
  "inlinks",
  "outlinks",
  "responseTime",
]);

function normalizeRecord(raw: Record<string, unknown>): CrawlRow | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = HEADER_MAP[key.trim().toLowerCase()];
    if (!field) continue;
    // Prefer "Unique Inlinks" only if plain Inlinks absent; last write wins is fine here.
    if (field in out && (key.toLowerCase().startsWith("unique") || value === "" || value == null)) continue;
    if (NUMERIC_FIELDS.has(field)) {
      const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(/,/g, ""));
      out[field] = Number.isFinite(n) ? n : 0;
    } else {
      out[field] = String(value ?? "").trim();
    }
  }
  const parsed = CrawlRowSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

export interface ParseResult {
  rows: CrawlRow[];
  warnings: string[];
}

/** Stream-parse a Screaming Frog CSV export. Never holds the raw file in memory as a string. */
export function parseCrawlCsv(
  file: File,
  onProgress: (rowsParsed: number) => void
): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const rows: CrawlRow[] = [];
    let skipped = 0;
    let count = 0;
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      worker: false,
      chunk: (chunk) => {
        for (const rec of chunk.data) {
          const row = normalizeRecord(rec);
          if (row && /^https?:\/\//i.test(row.url)) rows.push(row);
          else skipped++;
          count++;
        }
        onProgress(count);
      },
      complete: () => {
        const warnings: string[] = [];
        if (rows.length === 0) {
          reject(
            new Error(
              "No valid rows found. Make sure this is a Screaming Frog 'Internal: All' export with an Address column."
            )
          );
          return;
        }
        if (skipped > 0) warnings.push(`${skipped.toLocaleString()} rows skipped (non-URL or unparseable).`);
        resolve({ rows, warnings });
      },
      error: (err) => reject(new Error(`CSV parse failed: ${err.message}`)),
    });
  });
}

/** Parse an XLSX export (first sheet). SheetJS loads the workbook in memory; fine up to ~50k rows. */
export async function parseCrawlXlsx(
  file: File,
  onProgress: (rowsParsed: number) => void
): Promise<ParseResult> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", dense: true });
  const sheetName =
    wb.SheetNames.find((n) => /internal/i.test(n)) ?? wb.SheetNames[0];
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName], {
    defval: "",
  });
  const rows: CrawlRow[] = [];
  let skipped = 0;
  records.forEach((rec, i) => {
    const row = normalizeRecord(rec);
    if (row && /^https?:\/\//i.test(row.url)) rows.push(row);
    else skipped++;
    if (i % 2000 === 0) onProgress(i);
  });
  onProgress(records.length);
  if (rows.length === 0) {
    throw new Error(
      `No valid rows found in sheet "${sheetName}". Export "Internal: All" from Screaming Frog and try again.`
    );
  }
  const warnings = skipped ? [`${skipped.toLocaleString()} rows skipped (non-URL or unparseable).`] : [];
  return { rows, warnings };
}

const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * Best-effort .dbseospider ingestion. The format is proprietary and SQLite-backed;
 * table layout varies by Screaming Frog version. We open it with sql.js, look for a
 * table with URL-shaped columns, and map what we can. On any failure we throw a
 * message that routes the user to the fully supported CSV/XLSX path.
 */
export async function parseDbSeoSpider(
  file: File,
  onProgress: (rowsParsed: number) => void
): Promise<ParseResult> {
  const guidance =
    "Couldn't read this .dbseospider database (the internal layout is proprietary and version-specific). " +
    "In Screaming Frog use Bulk Export → or the top Export button on the Internal tab → save 'Internal: All' as CSV or XLSX, then upload that here. The CSV/XLSX path is fully supported.";
  const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (head !== SQLITE_MAGIC) {
    throw new Error(
      "This file isn't a SQLite database — likely a compressed .seospider project. " + guidance
    );
  }
  try {
    const initSqlJs = (await import("sql.js")).default;
    const SQL = await initSqlJs({
      locateFile: (f: string) => `https://sql.js.org/dist/${f}`,
    });
    const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    const tables: string[] = [];
    const res = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    for (const row of res[0]?.values ?? []) tables.push(String(row[0]));
    for (const table of tables) {
      const cols = db.exec(`PRAGMA table_info("${table}")`)[0]?.values.map((v) => String(v[1])) ?? [];
      const urlCol = cols.find((c) => /^(url|address)$/i.test(c));
      const statusCol = cols.find((c) => /status.?code/i.test(c));
      if (!urlCol || !statusCol) continue;
      const stmt = db.prepare(`SELECT * FROM "${table}"`);
      const rows: CrawlRow[] = [];
      let i = 0;
      while (stmt.step()) {
        const rec = stmt.getAsObject() as Record<string, unknown>;
        const row = normalizeRecord(rec);
        if (row && /^https?:\/\//i.test(row.url)) rows.push(row);
        if (++i % 2000 === 0) onProgress(i);
      }
      stmt.free();
      db.close();
      if (rows.length > 0) {
        return {
          rows,
          warnings: [
            `Read ${rows.length.toLocaleString()} rows from proprietary table "${table}". Field coverage may be partial — the CSV/XLSX export path is more complete.`,
          ],
        };
      }
    }
    db.close();
    throw new Error(guidance);
  } catch (e) {
    throw new Error(e instanceof Error && e.message.includes("Internal: All") ? e.message : guidance);
  }
}

export async function parseCrawlFile(
  file: File,
  onProgress: (n: number) => void
): Promise<ParseResult> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) return parseCrawlCsv(file, onProgress);
  if (name.endsWith(".xlsx")) return parseCrawlXlsx(file, onProgress);
  if (name.endsWith(".dbseospider") || name.endsWith(".seospider"))
    return parseDbSeoSpider(file, onProgress);
  throw new Error("Unsupported file type. Upload .csv, .xlsx, .seospider or .dbseospider.");
}

/** GSC → Performance → Pages export ("Pages.csv"): Top pages, Clicks, Impressions, CTR, Position */
export function parseGscPagesCsv(file: File): Promise<GscRow[]> {
  return new Promise((resolve, reject) => {
    const out: GscRow[] = [];
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: () => resolve(out),
      error: (e) => reject(new Error(`GSC CSV parse failed: ${e.message}`)),
      chunk: (chunk) => {
        for (const rec of chunk.data) {
          const keys = Object.keys(rec);
          const urlKey = keys.find((k) => /page|url/i.test(k));
          if (!urlKey || !/^https?:\/\//i.test(rec[urlKey] ?? "")) continue;
          const num = (re: RegExp) => {
            const k = keys.find((x) => re.test(x));
            const v = parseFloat(String(rec[k ?? ""] ?? "0").replace(/[%,]/g, ""));
            return Number.isFinite(v) ? v : 0;
          };
          out.push({
            url: rec[urlKey].trim(),
            clicks: num(/click/i),
            impressions: num(/impression/i),
            ctr: num(/ctr/i),
            position: num(/position/i),
          });
        }
      },
    });
  });
}

export interface InlinkEdge {
  source: string;
  target: string;
  anchor: string;
}

/** Screaming Frog "All Inlinks" export: Type, Source, Destination, ... Anchor Text ... */
export function parseAllInlinksCsv(
  file: File,
  onProgress: (n: number) => void
): Promise<InlinkEdge[]> {
  return new Promise((resolve, reject) => {
    const edges: InlinkEdge[] = [];
    let count = 0;
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      chunk: (chunk) => {
        for (const rec of chunk.data) {
          const keys = Object.keys(rec);
          const src = rec[keys.find((k) => /^source$/i.test(k)) ?? ""];
          const dst = rec[keys.find((k) => /^destination$/i.test(k)) ?? ""];
          const anchor = rec[keys.find((k) => /anchor/i.test(k)) ?? ""] ?? "";
          const type = rec[keys.find((k) => /^type$/i.test(k)) ?? ""] ?? "Hyperlink";
          if (src && dst && /hyperlink/i.test(type) && /^https?:\/\//i.test(src) && /^https?:\/\//i.test(dst)) {
            edges.push({ source: src.trim(), target: dst.trim(), anchor: anchor.trim() });
          }
          count++;
        }
        onProgress(count);
      },
      complete: () => {
        if (edges.length === 0) reject(new Error("No hyperlink edges found. Export Bulk Export → Links → All Inlinks."));
        else resolve(edges);
      },
      error: (e) => reject(new Error(`Inlinks CSV parse failed: ${e.message}`)),
    });
  });
}
