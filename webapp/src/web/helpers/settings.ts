import type { WhiteCalibration } from "../../server/pipeline/white";

/** "Red +9 % · paper measured 244 / 254 / 253": the channels raised by at least 1 %, and the measured paper. */
export function calibrationSummary(c: WhiteCalibration): string {
  const raised = (["Red", "green", "blue"] as const)
    .map((name, i) => [name, Math.round((c.gains[i]! - 1) * 100)] as const)
    .filter(([, pct]) => pct >= 1)
    .map(([name, pct], k) => `${k === 0 ? name[0]!.toUpperCase() + name.slice(1) : name.toLowerCase()} +${pct}\u00a0%`);
  const paper = `paper measured ${c.white.map(Math.round).join(" / ")}`;
  return `${raised.length ? raised.join(", ") : "No correction needed"} · ${paper}`;
}

/** Ready-to-paste client setup for the MCP endpoint. */
export function mcpClientSnippets(url: string, key: string): { claudeCode: string; header: string } {
  const header = `Authorization: Bearer ${key}`;
  return { claudeCode: `claude mcp add --transport http scanner ${url} --header "${header}"`, header };
}

export const PANEL_FORMATS = [
  ["jpeg", "JPEG"],
  ["tiff", "TIFF"],
  ["pdf", "PDF"],
] as const;
