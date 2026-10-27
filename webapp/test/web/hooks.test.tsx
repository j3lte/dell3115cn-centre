import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAutoLoadMore } from "../../src/web/hooks/useAutoLoadMore";
import { useChosenScan } from "../../src/web/hooks/useChosenScan";
import { useCopy } from "../../src/web/hooks/useCopy";
import { useHistory } from "../../src/web/hooks/useHistory";
import { useHistoryItems } from "../../src/web/hooks/useHistoryItems";
import { useHistorySelection } from "../../src/web/hooks/useHistorySelection";
import { useLive } from "../../src/web/hooks/useLive";
import { applyScan, forgetScan } from "../../src/web/lib/cache";
import { keys } from "../../src/web/lib/query";
import { useHashParts } from "../../src/web/hooks/useHashParts";
import { useMediaQuery } from "../../src/web/hooks/useMediaQuery";
import { usePick } from "../../src/web/hooks/usePick";
import { ROUTES } from "../../src/web/helpers/routes";
import { useRoute } from "../../src/web/hooks/useRoute";
import { useSaveInputProfile } from "../../src/web/hooks/useSaveInputProfile";
import { useSaveOutputProfile } from "../../src/web/hooks/useSaveOutputProfile";
import { flashSaved, useSaveProfile } from "../../src/web/hooks/useSaveProfile";
import { useThemeChoice } from "../../src/web/hooks/useThemeChoice";
import { useAutoDownload } from "../../src/web/hooks/useAutoDownload";
import { usePrinter } from "../../src/web/hooks/usePrinter";
import { useProfiles } from "../../src/web/hooks/useProfiles";
import { useScanStarter } from "../../src/web/hooks/useScanStarter";
import { startedHere } from "../../src/web/lib/storage";
import type { OutputProfile, ScanView } from "../../src/web/types/api";
import { FakeSocket } from "./fake-socket";
import { endpoint, printerViewOf, scanOf } from "./fixtures";
import { stubClipboard, stubFetch, stubMedia, useDom } from "./setup";

useDom();

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

const setHash = (hash: string) =>
  act(() => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

afterEach(() => {
  location.hash = "";
  localStorage.clear();
  sessionStorage.clear();
});

/** One QueryClient for every render of the hook (the shared `wrapper` makes a new one per render). */
const fixedWrapper = (existing?: QueryClient) => {
  const client = existing ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

test("useHashParts follows the hash", () => {
  location.hash = "#/history/abc";
  const { result } = renderHook(() => useHashParts(), { wrapper });
  expect(result.current).toEqual(["history", "abc"]);
  setHash("#/profiles/input/3");
  expect(result.current).toEqual(["profiles", "input", "3"]);
});

test("useRoute maps unknown hashes to scan", () => {
  location.hash = "#/nonsense";
  const { result } = renderHook(() => useRoute(ROUTES), { wrapper });
  expect(result.current).toBe("scan");
  setHash("#/printer");
  expect(result.current).toBe("printer");
});

test("useMediaQuery follows matchMedia", () => {
  const media = stubMedia(false);
  const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 1024px)"), { wrapper });
  expect(result.current).toBe(false);
  act(() => media.set(true));
  expect(result.current).toBe(true);
  unmount();
  expect(media.listeners.size).toBe(0);
});

test("usePick returns a stable callback", () => {
  const { result, rerender } = renderHook(() => usePick("test.pick", [1, 2]), { wrapper });
  const first = result.current[1];
  rerender();
  expect(result.current[1]).toBe(first);
  act(() => first(2));
  expect(result.current[0]).toBe(2);
  expect(localStorage.getItem("test.pick")).toBe("2");
});

test("useSaveProfile keeps its callbacks stable", () => {
  const { result, rerender } = renderHook(() => useSaveProfile(async () => 1, () => {}), { wrapper });
  const { run, setError } = result.current;
  rerender();
  expect(result.current.run).toBe(run);
  expect(result.current.setError).toBe(setError);
});

test("useSaveProfile runs the latest callbacks and says Saved.", async () => {
  const calls: string[] = [];
  const { result, rerender } = renderHook(({ tag }) => useSaveProfile(async () => tag, (v) => void calls.push(v)), {
    wrapper,
    initialProps: { tag: "first" },
  });
  rerender({ tag: "second" });
  await act(() => result.current.run());
  expect(calls).toEqual(["second"]);
  expect(result.current.ok).toBe("Saved.");
});

test("flashSaved makes the next useSaveProfile start out saved, once", () => {
  flashSaved();
  const remounted = renderHook(() => useSaveProfile(async () => 1, () => {}), { wrapper });
  expect(remounted.result.current.ok).toBe("Saved.");
  const later = renderHook(() => useSaveProfile(async () => 1, () => {}), { wrapper });
  expect(later.result.current.ok).toBeUndefined();
});

test("useThemeChoice keeps its setter stable and stores the choice", () => {
  const { result, rerender } = renderHook(() => useThemeChoice(), { wrapper });
  const set = result.current[1];
  rerender();
  expect(result.current[1]).toBe(set);
  act(() => set("dark"));
  expect(result.current[0]).toBe("dark");
});

test("useProfiles keeps the same empty lists while the profiles load", () => {
  stubFetch(() => new Promise<Response>(() => {}));
  const { result, rerender } = renderHook(() => useProfiles(), { wrapper: fixedWrapper() });
  const first = result.current;
  rerender();
  expect(result.current.loaded).toBe(false);
  expect(result.current.inputs).toBe(first.inputs);
  expect(result.current.outputs).toBe(first.outputs);
});

test("useAutoDownload downloads once when a scan this tab started is delivered for download, and not for others", async () => {
  const clicks: string[] = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicks.push(this.getAttribute("href")!);
  };
  try {
    const outputs = [{ id: 3, name: "Download", destination: { type: "download", config: {} } }] as unknown as OutputProfile[];
    const done = (id: string) =>
      ({
        id,
        status: "done",
        outputProfileId: 3,
        deliveries: [{ id: 1, outputProfileId: 3, outputProfileName: "Download", status: "sent", files: [{ name: `${id}.pdf`, url: `/f/${id}.pdf` }], createdAt: 1 }],
      }) as unknown as ScanView;
    startedHere.add("mine");
    const { rerender } = renderHook(({ scan }: { scan: ScanView }) => useAutoDownload(scan, outputs), { initialProps: { scan: done("other") }, wrapper });
    rerender({ scan: { ...done("mine"), status: "delivering" } });
    rerender({ scan: done("mine") });
    // The socket's next message for the same finished scan.
    rerender({ scan: done("mine") });
    await Bun.sleep(20);
    expect(clicks).toEqual(["/f/mine.pdf"]);
    expect(startedHere.all()).toEqual([]);
  } finally {
    HTMLAnchorElement.prototype.click = click;
  }
});

test("useScanStarter's start sets starting and reports the API error text", async () => {
  let answer!: (r: Response) => void;
  stubFetch(() => new Promise<Response>((res) => (answer = res)));
  const { result } = renderHook(() => useScanStarter({ inputId: 1, outputId: 2, review: false, dispatch: () => {} }), { wrapper: fixedWrapper() });
  let started!: Promise<void>;
  act(() => {
    started = result.current.start();
  });
  expect(result.current.starting).toBe(true);
  await waitFor(() => expect(answer).toBeDefined());
  await act(async () => {
    answer(Response.json({ error: "busy", message: "The scanner is busy" }, { status: 409 }));
    await started;
  });
  expect(result.current.starting).toBe(false);
  expect(result.current.error).toBe("The scanner is busy");
});

test("useScanStarter hands the started scan to the live state and keeps its callbacks stable", async () => {
  const scan = { id: "new1", status: "scanning", pages: [], deliveries: [] } as unknown as ScanView;
  const bodies: unknown[] = [];
  stubFetch(async (req) => {
    bodies.push(await req.clone().json());
    return Response.json(scan);
  });
  const dispatch = mock((_a: unknown) => {});
  const { result, rerender } = renderHook(() => useScanStarter({ inputId: 1, outputId: 2, review: true, dispatch }), { wrapper: fixedWrapper() });
  const { start, startArea } = result.current;
  rerender();
  expect(result.current.start).toBe(start);
  expect(result.current.startArea).toBe(startArea);
  await act(() => start());
  await act(() => startArea([10, 20, 80, 120]));
  expect(bodies).toEqual([
    { inputProfileId: 1, outputProfileId: 2, review: true },
    { inputProfileId: 1, outputProfileId: 2, review: true, areaMm: [10, 20, 80, 120] },
  ]);
  expect(dispatch).toHaveBeenCalledWith({ type: "scan", scan });
  expect(startedHere.all()).toEqual(["new1", "new1"]);
});

const histScan = (id: string, createdAt = 1) => ({ id, createdAt, status: "done", pages: [], deliveries: [] }) as unknown as ScanView;

test("useAutoLoadMore loads the next page when the sentinel shows, and not after a failed next page", () => {
  const observers: { cb: (e: { isIntersecting: boolean }[]) => void; disconnected: boolean }[] = [];
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    entry = { cb: undefined as never, disconnected: false };
    constructor(cb: never) {
      this.entry.cb = cb;
      observers.push(this.entry);
    }
    observe() {}
    disconnect() {
      this.entry.disconnected = true;
    }
  } as never;
  try {
    const fetchNextPage = mock(() => Promise.resolve());
    const q = { hasNextPage: true, isFetching: false, isFetchNextPageError: false, fetchNextPage };
    const Probe = ({ query }: { query: typeof q }) => <div ref={useAutoLoadMore(query)} />;
    const { rerender } = render(<Probe query={q} />);
    expect(observers.length).toBe(1);
    act(() => observers[0]!.cb([{ isIntersecting: true }]));
    expect(fetchNextPage).toHaveBeenCalledWith({ cancelRefetch: false });
    // A failed next page: the observer goes, "Load more" retries.
    rerender(<Probe query={{ ...q, isFetchNextPageError: true }} />);
    expect(observers[0]!.disconnected).toBe(true);
    expect(observers.length).toBe(1);
    rerender(<Probe query={{ ...q, hasNextPage: false }} />);
    expect(observers.length).toBe(1);
  } finally {
    globalThis.IntersectionObserver = original;
  }
});

test("useHistoryItems shows each scan once and reports the list state", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(keys.history, {
    pages: [
      { scans: [histScan("a", 3), histScan("b", 2)], next: 2 },
      { scans: [histScan("b", 2), histScan("c", 1)], next: undefined },
    ],
    pageParams: [undefined, 2],
  });
  stubFetch(() => Response.json([]));
  const { result } = renderHook(() => useHistoryItems(), { wrapper: fixedWrapper(client) });
  expect(result.current.items.map((s) => s.id)).toEqual(["a", "b", "c"]);
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBeUndefined();
});

test("useHistoryItems is loading until the first page arrives, then done when it is the last", async () => {
  let answer!: (r: Response) => void;
  stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
  const { result } = renderHook(() => useHistoryItems(), { wrapper: fixedWrapper() });
  expect(result.current).toMatchObject({ loading: true, done: false });
  answer(Response.json([histScan("a")]));
  await waitFor(() => expect(result.current).toMatchObject({ loading: false, done: true, items: [expect.objectContaining({ id: "a" })] }));
});

test("useHistoryItems reports a failed load", async () => {
  stubFetch(() => Response.json({ error: "internal", message: "Disk full" }, { status: 500 }));
  const { result } = renderHook(() => useHistoryItems(), { wrapper: fixedWrapper() });
  await waitFor(() => expect(result.current.error).toBe("Disk full"));
  expect(result.current).toMatchObject({ loading: false, done: false });
});

test("useCopy copies and says so", async () => {
  const written: string[] = [];
  stubClipboard(async (v) => void written.push(v));
  const { result } = renderHook(() => useCopy("key-1"), { wrapper });
  await act(() => result.current[1]());
  expect(written).toEqual(["key-1"]);
  expect(result.current[0]).toBe(true);
});

test("useCopy forgets its 2 s reset when unmounted", async () => {
  stubClipboard(async () => {});
  const set = spyOn(globalThis, "setTimeout");
  const clear = spyOn(globalThis, "clearTimeout");
  try {
    const { result, unmount } = renderHook(() => useCopy("k"), { wrapper });
    await act(() => result.current[1]());
    const reset = set.mock.results.find((_, i) => set.mock.calls[i]![1] === 2000)!.value;
    unmount();
    expect(clear).toHaveBeenCalledWith(reset);
  } finally {
    set.mockRestore();
    clear.mockRestore();
  }
});

test("useCopy without clipboard access changes nothing", async () => {
  stubClipboard(() => Promise.reject(new Error("insecure")));
  const { result } = renderHook(() => useCopy("key-2"), { wrapper });
  await act(() => result.current[1]());
  expect(result.current[0]).toBe(false);
});

test("useHistory decides about a next page from what the server sent, not from later live changes", async () => {
  // TanStack re-renders only for the result fields a render read.
  const watched = () => {
    const { data, hasNextPage, isSuccess } = useHistory();
    return { data, hasNextPage, isSuccess };
  };
  const full = Array.from({ length: 20 }, (_, i) => histScan(`f${i}`, 100 - i));
  stubFetch(() => Response.json(full));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(watched, { wrapper: fixedWrapper(qc) });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  // Deleting a scan from a full page: older scans are still there to load.
  act(() => forgetScan(qc, "f3"));
  await waitFor(() => expect(result.current.data?.pages[0]?.scans).toHaveLength(19));
  expect(result.current.hasNextPage).toBe(true);

  stubFetch(() => Response.json([histScan("a", 5)]));
  const short = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const second = renderHook(watched, { wrapper: fixedWrapper(short) }).result;
  await waitFor(() => expect(second.current.isSuccess).toBe(true));
  // New scans arriving live on a complete list: still nothing older to load.
  act(() => {
    for (let i = 0; i < 20; i++) applyScan(short, histScan(`n${i}`, 10 + i));
  });
  await waitFor(() => expect(second.current.data?.pages[0]?.scans).toHaveLength(21));
  expect(second.current.hasNextPage).toBe(false);
});

test("useHistorySelection picks a listed scan, fetches a deep link, and leaves before forgetting a deleted one", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { calls } = stubFetch((req) => (new URL(req.url).pathname === "/api/scans/far" ? Response.json(histScan("far")) : new Response("{}", { status: 404 })));
  const dispatch = mock(() => {});
  const items = [histScan("a")];
  const { result, rerender } = renderHook(({ id }: { id?: string }) => useHistorySelection(items, id, dispatch), { initialProps: { id: "a" } as { id?: string }, wrapper: fixedWrapper(client) });
  expect(result.current.selected?.id).toBe("a");
  expect(calls.length).toBe(0);
  rerender({ id: "far" });
  await waitFor(() => expect(result.current.selected?.id).toBe("far"));
  expect(calls.map((r) => new URL(r.url).pathname)).toEqual(["/api/scans/far"]);
  // Delete the listed scan: leave, forget, and ask the server nothing about it.
  rerender({ id: "a" });
  act(() => result.current.onDeleted("a"));
  expect(location.hash).toBe("#/history");
  expect(dispatch).toHaveBeenCalledWith({ type: "forget", id: "a" });
  rerender({ id: "a" });
  expect(calls.length).toBe(1);
  // A scan that does not exist is reported as missing.
  rerender({ id: "gone" });
  await waitFor(() => expect(result.current.missing).toBe(true));
  expect(result.current.selected).toBeUndefined();
});

test("useChosenScan fetches a chosen scan the live state doesn't hold and hands it over", async () => {
  const { calls } = stubFetch(() => Response.json(histScan("far")));
  const dispatch = mock((_a: unknown) => {});
  location.hash = "#/scan/far";
  renderHook(() => useChosenScan({ a: histScan("a") }, "far", dispatch), { wrapper: fixedWrapper() });
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "scan", scan: histScan("far") }));
  expect(calls.map(endpoint)).toEqual(["GET /api/scans/far"]);
  expect(location.hash).toBe("#/scan/far");
});

test("useChosenScan sends the page back to the newest scan when the chosen one is gone", async () => {
  stubFetch(() => Response.json({ error: "not_found", message: "No such scan" }, { status: 404 }));
  const dispatch = mock((_a: unknown) => {});
  location.hash = "#/scan/gone";
  renderHook(() => useChosenScan({}, "gone", dispatch), { wrapper: fixedWrapper() });
  await waitFor(() => expect(location.hash).toBe("#/scan"));
  expect(dispatch).not.toHaveBeenCalled();
});

test("useChosenScan asks nothing for a scan the live state holds", async () => {
  const { calls } = stubFetch(() => Response.json(histScan("a")));
  const dispatch = mock((_a: unknown) => {});
  renderHook(() => useChosenScan({ a: histScan("a") }, "a", dispatch), { wrapper: fixedWrapper() });
  await act(async () => {});
  expect(calls).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
});

test("saving a profile POSTs a new one and PUTs one with an id", async () => {
  const stub = stubFetch(async (req) => Response.json({ ...(await req.json()), id: 7 }));
  const input = renderHook(() => useSaveInputProfile(), { wrapper }).result;
  const output = renderHook(() => useSaveOutputProfile(), { wrapper }).result;
  await act(() => input.current.mutateAsync({ name: "New" } as never));
  await act(() => input.current.mutateAsync({ id: 3, name: "Old" } as never));
  await act(() => output.current.mutateAsync({ name: "New" } as never));
  await act(() => output.current.mutateAsync({ id: 4, name: "Old" } as never));
  expect(stub.calls.map(endpoint)).toEqual([
    "POST /api/input-profiles",
    "PUT /api/input-profiles/3",
    "POST /api/output-profiles",
    "PUT /api/output-profiles/4",
  ]);
});

test("useLive puts scan messages into the query cache and the live state", () => {
  FakeSocket.all = [];
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  try {
    const qc = new QueryClient();
    const { result, unmount } = renderHook(() => useLive(), { wrapper: fixedWrapper(qc) });
    const scan = scanOf({ id: "live-1" });
    act(() => FakeSocket.all[0]!.onmessage!({ data: JSON.stringify({ type: "scan", scan }) }));
    expect(qc.getQueryData(keys.scan("live-1"))).toEqual(scan);
    expect(result.current.state.scans["live-1"]).toEqual(scan);
    unmount();
  } finally {
    globalThis.WebSocket = original;
  }
});

test("usePrinter asks for a refresh-if-stale when the app opens and when the tab becomes visible again, not when hidden", async () => {
  const { calls } = stubFetch(async (req) => Response.json(printerViewOf({ pageCount: req.method === "POST" ? 2 : 1 })));
  const stale = () => calls.filter((r) => endpoint(r) === "POST /api/printer/refresh");
  const { result } = renderHook(() => usePrinter(), { wrapper: fixedWrapper() });
  await waitFor(() => expect(stale()).toHaveLength(1));
  expect(new URL(stale()[0]!.url).searchParams.get("ifStale")).toBe("true");
  expect(result.current.checking).toBe(false); // only Check now shows "Checking…"
  const visibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
  };
  try {
    visibility("hidden");
    expect(stale()).toHaveLength(1);
    visibility("visible");
    await waitFor(() => expect(stale()).toHaveLength(2));
  } finally {
    delete (document as { visibilityState?: unknown }).visibilityState;
  }
});

test("usePrinter's check always wakes the printer (no ifStale) and its result becomes the view", async () => {
  const { calls } = stubFetch(async (req) =>
    Response.json(printerViewOf({ pageCount: req.method === "POST" && !new URL(req.url).searchParams.has("ifStale") ? 3 : 1 })),
  );
  const { result } = renderHook(() => usePrinter(), { wrapper: fixedWrapper() });
  await waitFor(() => expect(result.current.view).not.toBeNull());
  await waitFor(() => expect(result.current.checking).toBe(false));
  await act(() => result.current.check());
  expect(calls.some((r) => r.method === "POST" && !new URL(r.url).searchParams.has("ifStale"))).toBe(true);
  await waitFor(() => expect(result.current.view?.pageCount).toBe(3));
});
