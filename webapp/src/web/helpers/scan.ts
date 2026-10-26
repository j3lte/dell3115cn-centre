import type { AreaMm, InputProfile, OutputProfile, ScanView } from "../types/api";
import { mm, plural } from "./format";
import { MODE_LABEL, PAPER_LABEL, SOURCE_LABEL } from "./labels";

export const isActive = (s: ScanView) => s.status === "scanning" || s.status === "delivering";

/** The newest delivery. */
export const lastDelivery = (s: ScanView) => s.deliveries[s.deliveries.length - 1];

/**
 * The delivery the scan's outcome is about: for a done scan the newest successful one (a later failed resend does not
 * undo it), otherwise the newest.
 */
export const shownDelivery = (s: ScanView) => (s.status === "done" ? s.deliveries.findLast((d) => d.status === "sent") : undefined) ?? lastDelivery(s);

/** A resend that failed after the scan was delivered successfully. */
export const failedResend = (s: ScanView) => {
  const last = lastDelivery(s);
  return s.status === "done" && last?.status === "failed" ? last : undefined;
};

export function isDownload(s: ScanView, outputs: readonly OutputProfile[], outputId = s.outputProfileId): boolean {
  return outputs.find((o) => o.id === outputId)?.destination.type === "download";
}

export function statusTitle(scan: ScanView, outputs: readonly OutputProfile[]): { title: string; tone: "busy" | "ok" | "error" | "muted" } {
  const n = scan.pages.length;
  const d = shownDelivery(scan);
  const target = d?.outputProfileName ?? scan.outputProfileName ?? "the output profile";
  switch (scan.status) {
    case "scanning":
      return { title: `Scanning page ${n + 1}…`, tone: "busy" };
    case "delivering":
      return { title: `Sending ${plural(n, "page")} to ${target}…`, tone: "busy" };
    case "done":
      return {
        title: d && isDownload(scan, outputs, d.outputProfileId ?? undefined) ? `✓ ${plural(n, "page")} ready to download` : `✓ Sent ${plural(n, "page")} to ${target}`,
        tone: "ok",
      };
    case "failed":
      return { title: n ? `Not sent: ${plural(n, "page")} kept in history` : "Scan failed", tone: "error" };
    case "cancelled":
      return { title: "Scan cancelled", tone: "muted" };
    case "ready":
      return { title: `${plural(n, "page")} scanned by an assistant, not sent`, tone: "muted" };
    default:
      return { title: `${plural(n, "page")} waiting for review`, tone: "muted" };
  }
}

/**
 * What History offers for a scan: "send" (a ready assistant scan: Send picks its output profile), "resend" (a
 * finished or cancelled scan with pages: delivers again without changing the scan's output profile) or nothing.
 */
export function historySend(scan: ScanView): "send" | "resend" | null {
  if (!scan.pages.length) return null;
  if (scan.status === "ready") return "send";
  if (scan.status === "done" || scan.status === "failed" || scan.status === "cancelled") return "resend";
  return null;
}

/** The settings a scan was made with, e.g. "Flatbed · Colour · 600 dpi · 16-bit · area 30×40 mm at 10, 20". */
export function scanSettingsSummary(p: InputProfile, area?: AreaMm | null): string {
  const parts: string[] = [SOURCE_LABEL[p.source], MODE_LABEL[p.mode], `${p.dpi} dpi`];
  if (p.depth === 16) parts.push("16-bit");
  // A feeder profile with "glass" paper (the API does not forbid it) shows no paper size here, as before.
  if (p.source === "adf" && p.paper !== "glass") parts.push(PAPER_LABEL[p.paper]);
  if (area) parts.push(`area ${mm(area[2])}×${mm(area[3])} mm at ${mm(area[0])}, ${mm(area[1])}`);
  return parts.join(" · ");
}

/** Output profiles with Download destinations first (they give the user a file), otherwise in their order. */
export function downloadFirst(outputs: readonly OutputProfile[]): OutputProfile[] {
  const dl = (o: OutputProfile) => o.destination.type === "download";
  return [...outputs.filter(dl), ...outputs.filter((o) => !dl(o))];
}

/** Status badges for a scan: sent / failed / … plus "partial" whenever the scan has a problem (e.g. a jam). */
export function statusBadges(scan: ScanView, outputs: readonly OutputProfile[]): [string, string][] {
  const last = shownDelivery(scan);
  const b: [string, string][] = [];
  switch (scan.status) {
    case "done":
      b.push(last && isDownload(scan, outputs, last.outputProfileId ?? undefined) ? ["ready", "badge-ok"] : ["sent", "badge-ok"]);
      if (failedResend(scan)) b.push(["resend failed", "badge-error"]);
      break;
    case "failed":
      b.push(["failed", "badge-error"]);
      break;
    case "scanning":
      b.push(["scanning", "badge-busy"]);
      break;
    case "delivering":
      b.push(["sending", "badge-busy"]);
      break;
    case "review":
      b.push(["in review", "badge-busy"]);
      break;
    case "ready":
      b.push(["not sent", ""]);
      break;
    default:
      b.push(["cancelled", ""]);
  }
  if (scan.origin === "mcp") b.push(["MCP", "badge-mcp"]);
  if (scan.problem) b.push(["partial", "badge-warn"]);
  return b;
}

/** Choices for a "send to" select: a placeholder until one is chosen, the chosen profile if it was deleted, then `outputs`. */
export function outputChoices(outputs: readonly OutputProfile[], chosen: number | undefined): [number | "", string][] {
  const head: [number | "", string][] =
    chosen === undefined ? [["", "Choose an output profile"]] : outputs.some((o) => o.id === chosen) ? [] : [[chosen, "(deleted profile)"]];
  return [...head, ...outputs.map((o): [number, string] => [o.id, o.name])];
}
