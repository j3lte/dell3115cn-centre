import { useState } from "react";
import { cx } from "../../helpers/format";
import { connectionInfo } from "../../helpers/live";
import type { ConnectionInfo, LiveState } from "../../types/ui";

const TONE: Record<ConnectionInfo["tone"], { box: string; dot: string }> = {
  ok: { box: "bg-surface", dot: "bg-ok" },
  busy: { box: "bg-surface", dot: "bg-busy animate-pulse" },
  warn: { box: "bg-warn-soft", dot: "bg-warn" },
  error: { box: "bg-danger-soft", dot: "bg-danger" },
};

/**
 * Scanner connection state with a Connect button when retrying now is worth it.
 * `bar`: sticky top bar (phone and tablet). `panel`: block at the top of the desktop sidebar.
 */
export function ConnectionBar({ state, onConnect, variant = "bar" }: { state: LiveState; onConnect: () => void; variant?: "bar" | "panel" }) {
  const info = connectionInfo(state);
  const [pressed, setPressed] = useState(false);
  const connect = () => {
    setPressed(true);
    onConnect();
    setTimeout(() => setPressed(false), 1500);
  };
  const detail = state.status.service === "unreachable" && state.status.error;
  const tone = TONE[info.tone];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        "connbar flex items-center gap-2.5 font-semibold",
        tone.box,
        variant === "bar"
          ? "sticky top-0 z-20 min-h-13 border-b border-line px-4 py-1.5 pt-[max(6px,env(safe-area-inset-top))] md:px-6"
          : "flex-wrap rounded-xl border border-line p-3",
      )}
    >
      <span className={cx("size-3 flex-none rounded-full", tone.dot)} aria-hidden="true" />
      <span className="connbar-text flex min-w-0 flex-1 flex-col">
        {info.text}
        {detail && <small className="truncate font-normal text-muted">{detail}</small>}
      </span>
      {info.canConnect && (
        <button className={cx("btn btn-sm", variant === "panel" && "w-full")} onClick={connect} disabled={pressed}>
          {pressed ? "Connecting…" : "Connect"}
        </button>
      )}
    </div>
  );
}
