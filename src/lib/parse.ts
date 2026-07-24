"use client";
import Papa from "papaparse";
import { listZipEntries, peekZipEntry, readZipEntry, ZipEntry } from "./zip";
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
  /** Link edges recovered from a .dbseospider database, when its layout allows. */
  edges?: InlinkEdge[];
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
const CSV_GUIDANCE =
  "In Screaming Frog open the crawl, go to the Internal tab \u2192 Export \u2192 save 'Internal: All' as CSV, then upload that here. " +
  "CSV is stream-parsed with no practical size limit, so this always works regardless of project size.";
const MAX_INNER_DB = 1_800 * 1024 * 1024; // browsers run out of address space past ~2GB

function sniff(bytes: Uint8Array): "sqlite" | "zip" | "gzip" | "unknown" {
  const ascii = new TextDecoder().decode(bytes.subarray(0, 16));
  if (ascii === SQLITE_MAGIC) return "sqlite";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip"; // PK
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  return "unknown";
}

const isSqliteBytes = (b: Uint8Array): boolean =>
  new TextDecoder().decode(b.subarray(0, 16)) === SQLITE_MAGIC;

/** Parse an in-memory SQLite database: find the URL table, map rows, hunt for a link-edge table. */
async function parseSqliteBytes(
  bytes: Uint8Array,
  onProgress: (n: number) => void,
  origin: string
): Promise<ParseResult> {
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs(
    typeof window === "undefined" ? {} : { locateFile: (f: string) => `https://sql.js.org/dist/${f}` }
  );
  const db = new SQL.Database(bytes);
  try {
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
      if (rows.length === 0) continue;

      // Bonus hunt: a link-edge table (source\u2192destination) unlocks Module D automatically.
      const edges: InlinkEdge[] = [];
      for (const linkTable of tables) {
        const linkCols = db.exec(`PRAGMA table_info("${linkTable}")`)[0]?.values.map((v) => String(v[1])) ?? [];
        const srcCol = linkCols.find((c) => /^(source|from|from_url|source_url)$/i.test(c));
        const dstCol = linkCols.find((c) => /^(destination|target|to|to_url|target_url|destination_url)$/i.test(c));
        if (!srcCol || !dstCol) continue;
        const anchorCol = linkCols.find((c) => /anchor|link_text/i.test(c));
        const linkStmt = db.prepare(`SELECT * FROM "${linkTable}"`);
        let n = 0;
        while (linkStmt.step() && n < 500_000) {
          const rec = linkStmt.getAsObject() as Record<string, unknown>;
          const src = String(rec[srcCol] ?? "");
          const dst = String(rec[dstCol] ?? "");
          if (/^https?:\/\//i.test(src) && /^https?:\/\//i.test(dst)) {
            edges.push({ source: src, target: dst, anchor: String(rec[anchorCol ?? ""] ?? "").trim() });
          }
          n++;
        }
        linkStmt.free();
        if (edges.length > 0) break;
      }
      const warnings = [
        `Read ${rows.length.toLocaleString()} rows from ${origin} table "${table}". Field coverage may be partial \u2014 the CSV export path is more complete.`,
      ];
      if (edges.length > 0) {
        warnings.push(`Recovered ${edges.length.toLocaleString()} link edges \u2014 Module D enabled automatically.`);
      } else {
        warnings.push("No readable link-edge table found \u2014 upload the All Inlinks export to enable Module D.");
      }
      return { rows, warnings, edges: edges.length > 0 ? edges : undefined };
    }
    throw new Error(`No table with URL + status-code columns found (tables present: ${tables.slice(0, 12).join(", ") || "none"}). ` + CSV_GUIDANCE);
  } finally {
    db.close();
  }
}

/** ZIP container: list entries WITHOUT loading the archive, sniff each for SQLite, extract the best one. */
async function parseZipContainer(file: File, onProgress: (n: number) => void): Promise<ParseResult> {
  let entries: ZipEntry[];
  try {
    entries = await listZipEntries(file);
  } catch (e) {
    throw new Error(`This file is a ZIP-style archive but its directory couldn't be read (${e instanceof Error ? e.message : "parse error"}). ` + CSV_GUIDANCE);
  }
  const files = entries.filter((e) => !e.name.endsWith("/") && e.uncompSize > 0);
  if (files.length === 0) throw new Error("This archive is empty. " + CSV_GUIDANCE);

  // Sniff decompressed heads, largest entries first (the crawl DB dominates the archive).
  const bySize = [...files].sort((a, b) => b.uncompSize - a.uncompSize);
  const sqliteEntries: ZipEntry[] = [];
  for (const e of bySize.slice(0, 40)) {
    try {
      if (isSqliteBytes(await peekZipEntry(file, e, 16))) sqliteEntries.push(e);
    } catch {
      /* unreadable entry \u2014 keep sniffing the rest */
    }
  }
  if (sqliteEntries.length === 0) {
    // Apache Derby signature: Screaming Frog's database storage mode keeps the
    // crawl in Derby conglomerates (sql/seg0/*.dat + service.properties). Only
    // the Derby engine (Java) can read that page format — but Screaming Frog's
    // own CLI converts the whole project to CSV in one headless command.
    const isDerby = files.some(
      (e) => /(^|\/)seg0\/c[0-9a-f]+\.dat$/i.test(e.name) || /(^|\/)service\.properties$/i.test(e.name)
    );
    if (isDerby) {
      const biggest = bySize[0];
      throw new Error(
        `This project uses Screaming Frog's database storage mode (Apache Derby — found ${files.length.toLocaleString()} database files, largest ${(biggest.uncompSize / 1024 / 1024 / 1024).toFixed(2)}GB). ` +
          `Derby can only be read by Screaming Frog itself, and no browser can hold a table that size. ` +
          `The fix is one command — Screaming Frog's own CLI converts this exact file to CSVs headlessly (close the Screaming Frog app first):\n\n` +
          `Windows — in Command Prompt:\ncd "C:\\Program Files (x86)\\Screaming Frog SEO Spider"\nScreamingFrogSEOSpiderCli.exe --headless --load-crawl "<path to your .dbseospider>" --export-tabs "Internal:All" --bulk-export "All Inlinks" --export-format csv --output-folder "C:\\auditforge-export" --overwrite\n\n` +
          `macOS/Linux: same flags via ScreamingFrogSEOSpiderLauncher.\n\n` +
          `That produces internal_all.csv — upload it here (stream-parsed, no size limit, the whole crawl at once) — and all_inlinks.csv — upload as All Inlinks to enable Module D. ` +
          `If the bulk export name errors, run: ScreamingFrogSEOSpiderCli.exe --help bulk-export\n\n` +
          `Prefer not to type any of this? Use the one-click converter button below \u2014 drag your project file onto the downloaded .bat and it does all of the above for you.`
      );
    }
    const listing = bySize
      .slice(0, 8)
      .map((e) => `${e.name} (${(e.uncompSize / 1024 / 1024).toFixed(1)}MB)`)
      .join(", ");
    throw new Error(
      `Opened the archive (${files.length.toLocaleString()} files: ${listing}${files.length > 8 ? ", \u2026" : ""}) but none is a SQLite database \u2014 ` +
        `this Screaming Frog version stores crawls in a format that can't be read in the browser. ` +
        CSV_GUIDANCE
    );
  }
  const target = sqliteEntries[0];
  if (target.uncompSize > MAX_INNER_DB) {
    throw new Error(
      `Found the database inside ("${target.name}", ${(target.uncompSize / 1024 / 1024 / 1024).toFixed(2)}GB uncompressed) but it's too large to load in a browser tab. ` +
        CSV_GUIDANCE
    );
  }
  onProgress(0);
  const bytes = await readZipEntry(file, target, MAX_INNER_DB);
  const result = await parseSqliteBytes(bytes, onProgress, `archived database "${target.name}",`);
  result.warnings.unshift(
    `Opened the project archive and extracted "${target.name}" (${(target.uncompSize / 1024 / 1024).toFixed(1)}MB) without loading the full archive into memory.`
  );
  return result;
}

/**
 * .seospider / .dbseospider ingestion. These are containers whose layout varies
 * by Screaming Frog version: raw SQLite, a ZIP archive wrapping the database,
 * or a gzip-compressed stream. We sniff the real format and open accordingly;
 * every failure path names exactly what was found and routes to the CSV export.
 */
export async function parseDbSeoSpider(
  file: File,
  onProgress: (rowsParsed: number) => void
): Promise<ParseResult> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const kind = sniff(head);

  if (kind === "sqlite") {
    if (file.size > MAX_INNER_DB) throw new Error(`This SQLite database is ${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB \u2014 too large to load in a browser tab. ` + CSV_GUIDANCE);
    return parseSqliteBytes(new Uint8Array(await file.arrayBuffer()), onProgress, "proprietary");
  }
  if (kind === "zip") {
    return parseZipContainer(file, onProgress);
  }
  if (kind === "gzip") {
    // Stream-decompress just the head to see what's inside the gzip wrapper.
    const headStream = file.slice(0, 256 * 1024).stream().pipeThrough(new DecompressionStream("gzip"));
    let inner = new Uint8Array(0);
    try {
      const reader = headStream.getReader();
      const { value } = await reader.read();
      inner = value ?? inner;
      await reader.cancel().catch(() => undefined);
    } catch {
      /* truncated stream is fine for sniffing */
    }
    if (isSqliteBytes(inner)) {
      const full = file.stream().pipeThrough(new DecompressionStream("gzip"));
      const reader = full.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total > MAX_INNER_DB) {
          await reader.cancel();
          throw new Error("The compressed database expands past what a browser tab can hold. " + CSV_GUIDANCE);
        }
      }
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) {
        bytes.set(c, o);
        o += c.length;
      }
      return parseSqliteBytes(bytes, onProgress, "gzip-wrapped");
    }
    throw new Error(
      "This is a gzip-compressed Screaming Frog project, but the data inside isn't a SQLite database \u2014 it's a serialization format that can't be read outside Screaming Frog. " +
        CSV_GUIDANCE
    );
  }
  const hex = Array.from(head.subarray(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  throw new Error(`Unrecognized file format (first bytes: ${hex}). ` + CSV_GUIDANCE);
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
export const MAX_INLINK_EDGES = 2_000_000;

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
      chunk: (chunk, parser) => {
        if (edges.length >= MAX_INLINK_EDGES) {
          parser.abort(); // memory guard \u2014 PageRank on 2M edges is already representative
          return;
        }
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
