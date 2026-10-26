import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { INITIAL_LIVE, liveReducer } from "../helpers/live";
import { applyScan } from "../lib/cache";
import { openLiveSocket, type LiveSocket } from "../lib/live-socket";

/**
 * Live connection to the app: reconnects with backoff 1 s → 10 s; each open delivers a fresh snapshot. Scan messages
 * also go into the query cache (`applyScan`): History and a fetched scan stay current, and a new scan appears at the
 * top of History.
 */
export function useLive() {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(liveReducer, INITIAL_LIVE);
  const socket = useRef<LiveSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const live = openLiveSocket(`${proto}//${location.host}/ws`, {
      onOpen: () => dispatch({ type: "socket", connected: true }),
      onClose: () => dispatch({ type: "socket", connected: false }),
      onMessage: (msg) => {
        dispatch(msg);
        if (msg.type === "scan") applyScan(queryClient, msg.scan);
      },
    });
    socket.current = live;
    // A phone waking up: reconnect immediately instead of waiting for the backoff.
    const wake = () => {
      if (document.visibilityState === "visible" && !live.hasSocket()) live.connectNow();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      live.close();
      socket.current = null;
    };
  }, [queryClient]);

  /** Connect button: retry the scanner service now (and this socket, if it is down). */
  const reconnect = useCallback(() => {
    if (socket.current?.send({ type: "connect" })) return;
    socket.current?.reconnect();
    fetch("/api/connect", { method: "POST" }).catch(() => {});
  }, []);

  return { state, dispatch, reconnect };
}

export type Live = ReturnType<typeof useLive>;
