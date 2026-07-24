import fs from "node:fs";
import { parseDbSeoSpider } from "@/lib/parse";

async function load(p: string, name: string): Promise<File> {
  return new File([fs.readFileSync(p)], name);
}
const noop = () => undefined;

(async () => {
  // ZIP-wrapped DB (the user's case) → must open, extract, parse rows AND edges
  const r1 = await parseDbSeoSpider(await load("/tmp/fx/AiTech-July.dbseospider", "AiTech-July.dbseospider"), noop);
  if (r1.rows.length !== 50) throw new Error(`zip: expected 50 rows, got ${r1.rows.length}`);
  if (!r1.edges || r1.edges.length !== 50) throw new Error("zip: edges not recovered");
  if (!r1.warnings[0].includes("extracted")) throw new Error("zip: missing extraction note");
  console.log("ZIP-wrapped project:  PASS —", r1.warnings[0]);

  // gzip-wrapped DB
  const r2 = await parseDbSeoSpider(await load("/tmp/fx/gz.seospider", "gz.seospider"), noop);
  if (r2.rows.length !== 50) throw new Error("gzip: rows wrong");
  console.log("GZIP-wrapped project: PASS —", r2.rows.length, "rows");

  // raw sqlite
  const r3 = await parseDbSeoSpider(await load("/tmp/fx/raw.dbseospider", "raw.dbseospider"), noop);
  if (r3.rows.length !== 50) throw new Error("raw: rows wrong");
  console.log("Raw SQLite project:   PASS —", r3.rows.length, "rows");

  // ZIP with no DB → precise error naming the contents + CSV route
  try {
    await parseDbSeoSpider(await load("/tmp/fx/nodb.dbseospider", "nodb.dbseospider"), noop);
    throw new Error("nodb: should have thrown");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("none is a SQLite database") || !msg.includes("Internal: All") || !msg.includes("data.bin"))
      throw new Error("nodb: wrong message: " + msg);
    console.log("Archive w/o DB:       PASS — precise error naming contents + CSV route");
  }
  // Derby-mode project (the 7GB real-world case) → actionable CLI recipe, no generic shrug
  try {
    await parseDbSeoSpider(await load("/tmp/fx/derby.dbseospider", "derby.dbseospider"), noop);
    throw new Error("derby: should have thrown");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (!msg.includes("Apache Derby") || !msg.includes("--load-crawl") || !msg.includes("Internal:All") || !msg.includes("All Inlinks"))
      throw new Error("derby: wrong message: " + msg.slice(0, 200));
    console.log("Derby-mode project:   PASS — detected, error carries the exact CLI conversion command");
  }
  console.log("\nALL ARCHIVE PARSER TESTS PASSED");
})();
