import type { ScannerStatus } from "./scanner-client";
import type { ScanView } from "./services/scan-service";

export type LiveMessage =
  | { type: "status"; status: ScannerStatus }
  | { type: "scan"; scan: ScanView }
  /** One-off message for the user, e.g. a printer button press that could not start a scan. */
  | { type: "notice"; message: string };

export interface LiveSocket {
  send(data: string): unknown;
}

/** Fans live messages out to WebSocket clients. A newly attached socket first gets the full snapshot. */
export class LiveHub {
  private sockets = new Set<LiveSocket>();
  private snapshot: () => LiveMessage[] = () => [];

  constructor(private readonly onConnectRequest?: () => void) {}

  setSnapshot(fn: () => LiveMessage[]): void {
    this.snapshot = fn;
  }

  attach(ws: LiveSocket): void {
    this.sockets.add(ws);
    for (const msg of this.snapshot()) this.sendTo(ws, msg);
  }

  detach(ws: LiveSocket): void {
    this.sockets.delete(ws);
  }

  broadcast(msg: LiveMessage): void {
    for (const ws of this.sockets) this.sendTo(ws, msg);
  }

  /** Incoming client message. `{type:"connect"}` asks the server to retry the scanner connection now. */
  message(_ws: LiveSocket, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "connect") this.onConnectRequest?.();
  }

  private sendTo(ws: LiveSocket, msg: LiveMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.sockets.delete(ws);
    }
  }
}
