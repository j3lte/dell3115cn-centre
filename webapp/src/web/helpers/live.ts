import type { ScanView } from "../types/api";
import type { ConnectionInfo, LiveAction, LiveState } from "../types/ui";
import { isActive } from "./scan";

export const INITIAL_LIVE: LiveState = {
  connected: false,
  status: { service: "connecting", printer: null, paperInFeeder: false },
  scans: {},
};

/** Pure reducer over server messages and socket events. A (re)connect starts a fresh snapshot. */
export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "socket":
      // The server sends a full snapshot right after the socket opens, so old scans are dropped then.
      return action.connected ? { ...state, connected: true, scans: {} } : { ...state, connected: false };
    case "status":
      return { ...state, status: action.status };
    case "scan":
      return { ...state, scans: { ...state.scans, [action.scan.id]: action.scan } };
    case "forget": {
      const { [action.id]: _gone, ...rest } = state.scans;
      return { ...state, scans: rest };
    }
    case "notice":
      return { ...state, notice: { message: action.message, at: Date.now() } };
    case "dismissNotice":
      return { ...state, notice: undefined };
    default:
      return state;
  }
}

/** The newest scan known to the client. */
export function activeScan(state: LiveState): ScanView | undefined {
  let best: ScanView | undefined;
  for (const s of Object.values(state.scans)) if (!best || s.createdAt >= best.createdAt) best = s;
  return best;
}

/** What the connection bar shows, and whether Scan is allowed. */
export function connectionInfo(state: LiveState): ConnectionInfo {
  const s = state.status;
  if (!state.connected || s.service === "connecting") return { tone: "busy", text: "Connecting…", canConnect: false, ready: false };
  if (s.service === "unreachable") return { tone: "error", text: "Can't reach the scanner service — retrying", canConnect: true, ready: false };
  switch (s.printer) {
    case "off":
      return { tone: "error", text: "Printer is off — switch it on", canConnect: true, ready: false };
    case "jammed":
      return { tone: "warn", text: "Paper jam — open and close the ADF cover", canConnect: false, ready: false };
    case "scanning":
      return { tone: "busy", text: "Scanning…", canConnect: false, ready: false };
    case "idle":
      return { tone: "ok", text: s.paperInFeeder ? "Ready · paper in feeder" : "Ready", canConnect: false, ready: true };
    default:
      return { tone: "busy", text: "Connecting…", canConnect: false, ready: false };
  }
}

/** The scan sits in the review tray (waiting, or scanning more pages into it). */
export const inTray = (s: ScanView) => s.status === "review" || (s.review && s.status === "scanning" && s.origin !== "mcp");

/**
 * The scan the Scan page shows: the one the user chose (Open in review, pending list) while the client knows it,
 * unless a newer scan is in progress and the chosen one is idle (e.g. a printer-button scan); otherwise the newest.
 */
export function displayedScan(scans: Record<string, ScanView>, chosenId?: string): ScanView | undefined {
  const newest = activeScan({ scans } as LiveState);
  const chosen = chosenId ? scans[chosenId] : undefined;
  if (!chosen) return newest;
  if (newest && newest.id !== chosen.id && isActive(newest) && !isActive(chosen) && newest.createdAt > chosen.createdAt) return newest;
  return chosen;
}

/** Scans waiting in the review tray other than the one shown, newest first. */
export function pendingReview(scans: Record<string, ScanView>, shownId?: string): ScanView[] {
  return Object.values(scans)
    .filter((s) => s.id !== shownId && inTray(s))
    .sort((a, b) => b.createdAt - a.createdAt);
}
