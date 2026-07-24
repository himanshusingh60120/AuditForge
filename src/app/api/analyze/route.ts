import { NextRequest, NextResponse } from "next/server";
import { AnalyzeRequestSchema, ExecSummary, RuleAnalysis } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = () => process.env.OPENAI_MODEL || "gpt-4o-mini";

async function openai(messages: { role: string; content: string }[]): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL(),
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty completion from OpenAI");
  return content;
}

function safeJson<T>(raw: string): T {
  return JSON.parse(raw.replace(/^```json\s*|```\s*$/g, "")) as T;
}

const SYSTEM = `You are a senior technical SEO consultant writing for a mixed dev/content/SEO team.
Hard rules: explain and prioritize only the issues given to you — never invent new issues, URLs, or metrics.
Fix instructions must be concrete: exact HTML / nginx / .htaccess / Next.js snippets where relevant.
Respond ONLY with valid JSON matching the requested shape.`;

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "AI analysis skipped: OPENAI_API_KEY is not set. All verified findings are still in the report." },
      { status: 501 }
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = AnalyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request shape." }, { status: 400 });
  }
  const { groups, siteStats } = parsed.data;

  try {
    // One call for ALL issue-type groups (batched to minimize tokens), one for the exec summary.
    const groupPrompt = `For each confirmed issue type below, produce an entry. Input:
${JSON.stringify(groups, null, 1)}

Return JSON: {"analyses":[{"ruleId":string,"explanation":string (2-3 plain-English sentences),"rootCause":string,"fixSteps":string[] (3-6 imperative steps),"codeSnippet":string (copy-pasteable, correct for the issue; "" if none applies),"effort":"S"|"M"|"L","owner":"Dev"|"Content"|"SEO"}]}`;

    const summaryPrompt = `Site audit stats: ${JSON.stringify(siteStats)}. Confirmed issue groups (type, severity, count): ${JSON.stringify(
      groups.map((g) => ({ type: g.ruleLabel, severity: g.severity, count: g.count }))
    )}.
Return JSON: {"grade":string (A-F letter, consistent with a health score of ${siteStats.healthScore}/100),"narrative":string (4-6 sentence executive summary for stakeholders),"topPriorities":string[] (top 5, most impactful first),"projectedImpact":string (2-3 sentences, honest, no invented numbers),"actionPlan30Day":string[] (week-by-week, 4 entries)}`;

    const [groupRaw, summaryRaw] = await Promise.all([
      openai([
        { role: "system", content: SYSTEM },
        { role: "user", content: groupPrompt },
      ]),
      openai([
        { role: "system", content: SYSTEM },
        { role: "user", content: summaryPrompt },
      ]),
    ]);

    const analyses = safeJson<{ analyses: RuleAnalysis[] }>(groupRaw).analyses ?? [];
    const execSummary = safeJson<ExecSummary>(summaryRaw);
    return NextResponse.json({ analyses, execSummary });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "AI analysis failed" },
      { status: 502 }
    );
  }
}
