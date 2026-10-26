import type { LiveMessage } from "../../server/live";

export type LiveHandlers = { onOpen(): void; onClose(): void; onMessage(m: LiveMessage): void };

export type LiveSocketOptions = {
  WebSocket?: typeof WebSocket;
  backoffMs?: number[];
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type LiveSocket = {
  /** Connect now and start the backoff over. */
  reconnect(): void;
  /** Connect now, keeping the backoff where it is (a page waking up). No-op after `close()`. */
  connectNow(): void;
  /** Send a JSON message when the socket is open; `false` when it is not. */
  send(message: unknown): boolean;
  /** Whether a socket exists (connecting or open), as opposed to waiting for a retry. */
  hasSocket(): boolean;
  /** Close for good: no further reconnects. */
  close(): void;
};

const BACKOFF_MS = [1000, 2000, 5000, 10000];

/**
 * A WebSocket that reconnects with backoff (1 s → 10 s, back to 1 s after an open). Malformed frames are ignored.
 * No React: `useLive` wraps it.
 */
export function openLiveSocket(url: string, handlers: LiveHandlers, opts: LiveSocketOptions = {}): LiveSocket {
  const Ws = opts.WebSocket ?? WebSocket;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const setTimer = opts.setTimeout ?? setTimeout;
  const clearTimer = opts.clearTimeout ?? clearTimeout;
  let sock: WebSocket | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const open = () => {
    clearTimer(timer);
    if (stopped) return;
    const s = new Ws(url);
    sock = s;
    s.onopen = () => {
      attempt = 0;
      handlers.onOpen();
    };
    s.onmessage = (e) => {
      try {
        handlers.onMessage(JSON.parse(String(e.data)) as LiveMessage);
      } catch {
        // ignore malformed frames
      }
    };
    s.onclose = () => {
      if (sock !== s) return;
      sock = null;
      handlers.onClose();
      if (stopped) return;
      const wait = backoff[Math.min(attempt++, backoff.length - 1)];
      timer = setTimer(open, wait);
    };
  };
  open();

  return {
    reconnect() {
      attempt = 0;
      open();
    },
    connectNow: open,
    send(message) {
      if (!sock || sock.readyState !== Ws.OPEN) return false;
      sock.send(JSON.stringify(message));
      return true;
    },
    hasSocket: () => sock !== null,
    close() {
      stopped = true;
      clearTimer(timer);
      sock?.close();
    },
  };
}
