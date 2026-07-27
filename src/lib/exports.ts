"use client";
import { AuditState, Issue, severityRank } from "./schema";

export function downloadText(filename: string, content: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function issueRows(issues: Issue[]): Record<string, string | number>[] {
  return issues.map((i) => ({
    URL: i.url,
    Issue: i.ruleLabel,
    Severity: i.severity,
    "Impact Score": i.impactScore,
    Verification: i.verification,
    "Verified At": i.verifiedAt ?? "",
    "Crawl Evidence": i.evidence,
    "Live Evidence": i.liveEvidence ?? "",
    "Verify Error": i.verifyError ?? "",
    Owner: i.owner,
    "Fix Status": i.fixStatus,
    "GSC Clicks": i.gscClicks ?? "",
    "GSC Impressions": i.gscImpressions ?? "",
    "GSC Coverage": i.gscCoverageState ?? "",
    "Source: Sitemaps (GSC)": (i.sourceSitemaps ?? []).join("\n"),
    "Source: Referring Pages (GSC)": (i.sourceReferringPages ?? []).join("\n"),
    "Source: Internal Inlinks (crawl)": (i.sourceInternalInlinks ?? []).join("\n"),
  }));
}

/** One workbook: Master sheet + one sheet per issue type. */
export async function exportXlsx(audit: AuditState): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const sorted = [...audit.issues].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.impactScore - a.impactScore
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows(sorted)), "Master");

  const byRule = new Map<string, Issue[]>();
  for (const i of sorted) {
    const list = byRule.get(i.ruleId) ?? [];
    list.push(i);
    byRule.set(i.ruleId, list);
  }
  for (const [ruleId, list] of byRule) {
    const name = ruleId.slice(0, 31).replace(/[[\]*/\\?:]/g, "-");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(issueRows(list)), name);
  }
  if (audit.headerFindings.length > 0) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        audit.headerFindings.map((h) => ({ URL: h.url, Check: h.check, Grade: h.grade, Detail: h.detail }))
      ),
      "Header audit"
    );
  }
  XLSX.writeFile(wb, `auditforge-${audit.meta.auditId}.xlsx`);
}

export function exportAuditJson(audit: AuditState): void {
  downloadText(`auditforge-${audit.meta.auditId}.json`, JSON.stringify(audit), "application/json");
}
