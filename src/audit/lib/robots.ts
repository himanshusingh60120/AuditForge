/** Minimal, spec-faithful robots.txt matcher (wildcards *, anchors $, longest-match-wins). */

export interface RobotsRule {
  type: "allow" | "disallow";
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ type: key, pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const anchored = escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped;
  return new RegExp("^" + anchored);
}

export interface RobotsVerdict {
  allowed: boolean;
  matchedRule: string | null;
  group: string;
}

export function checkRobots(
  groups: RobotsGroup[],
  path: string,
  userAgent = "auditforgebot"
): RobotsVerdict {
  const ua = userAgent.toLowerCase();
  let group =
    groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a))) ??
    groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, matchedRule: null, group: "(no matching group)" };

  let best: { rule: RobotsRule; len: number } | null = null;
  for (const rule of group.rules) {
    if (!rule.pattern) continue; // empty Disallow = allow all
    if (patternToRegex(rule.pattern).test(path)) {
      const len = rule.pattern.length;
      if (!best || len > best.len || (len === best.len && rule.type === "allow")) {
        best = { rule, len };
      }
    }
  }
  if (!best) return { allowed: true, matchedRule: null, group: group.agents.join(", ") };
  return {
    allowed: best.rule.type === "allow",
    matchedRule: `${best.rule.type === "allow" ? "Allow" : "Disallow"}: ${best.rule.pattern}`,
    group: group.agents.join(", "),
  };
}
