import type { LiveMessage } from "../../server/live";
import type { Filter, InputProfile, OutputProfile, PrinterView, ScannerStatus, ScanView } from "./api";

export type Route = "scan" | "history" | "printer" | "profiles" | "settings";

/** Profile kind as it appears in the route: `#/profiles/in/<id>`, `#/profiles/out/new`. */
export type ProfileKind = "in" | "out";

export type Profiles = {
  /** Read-only: the arrays are the query cache's own (or one shared empty array while loading). */
  inputs: readonly InputProfile[];
  outputs: readonly OutputProfile[];
  loaded: boolean;
  error?: string;
};

/** Live state of the app as seen through the /ws socket. */
export type LiveState = {
  /** WebSocket to this app is open. */
  connected: boolean;
  status: ScannerStatus;
  /** Scans the server told us about (active + most recent), by id. */
  scans: Record<string, ScanView>;
  /** Last one-off notice from the server (e.g. a printer button press that could not start a scan). */
  notice?: { message: string; at: number };
};

export type LiveAction =
  | LiveMessage
  | { type: "socket"; connected: boolean }
  | { type: "forget"; id: string }
  | { type: "dismissNotice" };

export type ConnectionInfo = {
  tone: "ok" | "busy" | "warn" | "error";
  text: string;
  /** Show the Connect button. */
  canConnect: boolean;
  /** A new scan can start. */
  ready: boolean;
};

export type Printer = { view: PrinterView | null; checking: boolean; check: () => Promise<void> };

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** What the review tray does to one page of its scan (page numbers start at 1). */
export type PageActions = {
  move: (from: number, to: number) => void;
  rotate: (n: number) => void;
  remove: (n: number) => void;
  /** `null` = use the scan filter again. */
  setFilter: (n: number, f: Filter | null) => void;
};

/** What the Scan page's form has chosen: the profiles (undefined = none yet) and "Review before sending". */
export type ScanChoice = {
  input: InputProfile | undefined;
  output: OutputProfile | undefined;
  review: boolean;
  setInputId: (id: number) => void;
  setOutputId: (id: number) => void;
  setReview: (v: boolean) => void;
};

/** Saves a settings patch; `what` names it in the "saved" notice. Failures are shown by the Settings page. */
export type SaveSetting = (patch: Record<string, unknown>, what: string) => Promise<void>;
