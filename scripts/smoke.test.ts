import fs from "node:fs";
import Papa from "papaparse";
import { detectIssues } from "@/lib/detect";
import { computeImpactScores, computePagerank, healthScore, computeDelta } from "@/lib/analysis";
import { analyzeUrlHygiene, buildRedirectMap, redirectMapAsNginx, issuesAsJiraCsv, diffSitemap } from "@/lib/modules";
import { parseRobotsTxt, checkRobots } from "@/lib/robots";
import { CrawlRowSchema, CrawlRow } from "@/lib/schema";

// --- parse fixture (same normalization map as client, inlined minimal) ---
const csv = fs.readFileSync("fixtures/sample_internal_all.csv", "utf8");
const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
const H: Record<string, string> = {
  "address":"url","status code":"statusCode","indexability":"indexability","indexability status":"indexabilityStatus",
  "title 1":"title","title 1 length":"titleLength","meta description 1":"metaDescription","meta description 1 length":"metaLength",
  "h1-1":"h1","h1-2":"h1Second","h2-1":"h2","canonical link element 1":"canonical","meta robots 1":"metaRobots",
  "word count":"wordCount","crawl depth":"crawlDepth","inlinks":"inlinks","outlinks":"outlinks","response time":"responseTime",
  "content type":"contentType","redirect url":"redirectUrl","redirect type":"redirectType"
};
const NUM = new Set(["statusCode","titleLength","metaLength","wordCount","crawlDepth","inlinks","outlinks","responseTime"]);
const rows: CrawlRow[] = [];
for (const rec of parsed.data) {
  const o: Record<string, unknown> = {};
  for (const [k,v] of Object.entries(rec)) {
    const f = H[k.trim().toLowerCase()]; if (!f) continue;
    o[f] = NUM.has(f) ? (parseFloat(v)||0) : (v??"").trim();
  }
  const r = CrawlRowSchema.safeParse(o);
  if (r.success) rows.push(r.data);
}
console.log("rows parsed:", rows.length);
if (rows.length !== 25) throw new Error("expected 25 rows");

// --- detection ---
const issues = detectIssues(rows);
const byRule = new Map<string, number>();
for (const i of issues) byRule.set(i.ruleId, (byRule.get(i.ruleId)??0)+1);
console.log("issues:", issues.length, Object.fromEntries(byRule));
const expect = ["http-4xx","http-5xx","redirect-302","redirect-chain","redirect-loop","title-missing" /*none actually*/,]
for (const must of ["http-4xx","http-5xx","redirect-302","redirect-chain","redirect-loop","title-duplicate","meta-missing","meta-duplicate","h1-missing","h1-multiple","canonical-missing","canonical-noindex-conflict","canonical-to-non-200","noindex-with-inlinks","orphan-in-crawl","deep-page","thin-content","slow-response","title-long","title-short"]) {
  if (!byRule.has(must)) throw new Error("missing expected rule hit: " + must);
}

// --- impact + health ---
const scored = computeImpactScores(issues, rows, [{url:"https://example.com/pricing",clicks:500,impressions:20000,ctr:2.5,position:4.2}]);
const pricing = scored.filter(i=>i.url==="https://example.com/pricing");
console.log("pricing impact:", pricing.map(i=>`${i.ruleId}=${i.impactScore}`).join(", "));
if (!pricing.every(i=>i.impactScore>0)) throw new Error("gsc weighting failed");
console.log("health:", healthScore(scored, rows.length));

// --- redirect map ---
const map = buildRedirectMap(rows);
const old = map.find(m=>m.source==="https://example.com/blog/old-post");
console.log("redirect old-post →", old?.finalDestination, "hops:", old?.hops);
if (old?.finalDestination !== "https://example.com/blog/new-post" || old.hops !== 2) throw new Error("chain collapse failed");
console.log(redirectMapAsNginx(map).split("\n")[1]);

// --- hygiene ---
const hyg = analyzeUrlHygiene(rows);
console.log("hygiene:", hyg.map(h=>`${h.pattern}×${h.count}`).join(" | ") || "(none)");

// --- robots matcher ---
const robots = parseRobotsTxt(`User-agent: *\nDisallow: /admin\nAllow: /admin/public\nDisallow: /*?*sort=\nUser-agent: googlebot\nDisallow: /gbot-only$`);
const t = (p:string,ua="anybot") => checkRobots(robots,p,ua);
if (t("/admin/x").allowed) throw new Error("robots 1");
if (!t("/admin/public/x").allowed) throw new Error("robots 2");
if (t("/products?a=1&sort=price").allowed) throw new Error("robots 3");
if (t("/gbot-only","googlebot").allowed) throw new Error("robots 4");
if (!t("/gbot-only/x","googlebot").allowed) throw new Error("robots 5 ($ anchor)");
console.log("robots matcher: all assertions pass");

// --- pagerank ---
const inlinksCsv = fs.readFileSync("fixtures/sample_all_inlinks.csv","utf8");
const ip = Papa.parse<Record<string,string>>(inlinksCsv,{header:true,skipEmptyLines:true});
const edges = ip.data.map(r=>({source:r["Source"],target:r["Destination"],anchor:r["Anchor Text"]??""})).filter(e=>e.source&&e.target);
const pr = computePagerank(edges, rows);
console.log("PR top:", pr.topPages[0]?.url, "| equity leaks:", pr.equityLeaks.length, "| deadEnds:", pr.deadEnds.length, "| opps:", pr.opportunities.length);
if (pr.equityLeaks.length === 0) throw new Error("expected equity leaks (links to 404/redirects)");

// --- sitemap diff ---
const sm = diffSitemap(["https://example.com/","https://example.com/ghost-page","https://example.com/legacy/widgets"], rows, [{url:"https://example.com/pricing",clicks:500,impressions:20000,ctr:2.5,position:4.2}]);
console.log("sitemap: notCrawled", sm.inSitemapNotCrawled, "| pollution", sm.sitemapPollution, "| gscMissing", sm.gscMissingFromSitemap.length);
if (!sm.inSitemapNotCrawled.includes("https://example.com/ghost-page")) throw new Error("sitemap orphan detect failed");
if (sm.sitemapPollution.length !== 1) throw new Error("sitemap pollution detect failed");

// --- delta ---
const prevState:any = { meta:{createdAt:"",name:"",auditId:"prev"}, rows, issues: scored.slice(0, 5).map(i=>({...i, verification:"CONFIRMED"})), headerFindings:[],gsc:[],sitemapUrls:[],inlinksLoaded:false,parseWarnings:[] };
const curState:any = { ...prevState, issues: [...scored.slice(2)].map(i=>({...i, verification:"CONFIRMED"})) };
const d = computeDelta(prevState, curState);
console.log("delta: new", d.newIssues.length, "fixed", d.fixedIssues.length, "regressed", d.regressed.length);
if (d.fixedIssues.length !== 2) throw new Error("delta fixed count wrong");

// --- jira csv ---
const jira = issuesAsJiraCsv(scored.map(i=>({...i, verification:"CONFIRMED" as const})));
console.log("jira csv lines:", jira.split("\n").length);
console.log("\nALL SMOKE TESTS PASSED");
