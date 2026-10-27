import { beforeAll, describe, expect, test } from "bun:test";
import { environmentManager } from "@tanstack/query-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { DEDA_POLL_MS, dedaPoll } from "../../src/web/helpers/deda";
import type { DedaCandidate, DedaView } from "../../src/web/types/api";
import { endpoint, path } from "./fixtures";
import { renderCount, renderWithQuery, screen, stubFetch, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix reads `document` when imported: load every component that imports Radix after happy-dom is registered.
let DedaPage: typeof import("../../src/web/pages/DedaPage").DedaPage;
let DedaList: typeof import("../../src/web/components/analyse/DedaList").DedaList;
let DedaResult: typeof import("../../src/web/components/analyse/DedaResult").DedaResult;
let useDedaAnalyses: typeof import("../../src/web/hooks/useDedaAnalyses").useDedaAnalyses;
beforeAll(async () => {
  ({ DedaPage } = await import("../../src/web/pages/DedaPage"));
  ({ DedaList } = await import("../../src/web/components/analyse/DedaList"));
  ({ DedaResult } = await import("../../src/web/components/analyse/DedaResult"));
  ({ useDedaAnalyses } = await import("../../src/web/hooks/useDedaAnalyses"));
});

const T = 1_700_000_000_000;

/** A finished analysis of a page with dots and a decode (fake serial). */
const dedaOf = (over: Partial<DedaView> = {}): DedaView => ({
  id: "d1",
  name: "Deda scan 2023-11-14 23:13:20",
  status: "done",
  source: "history",
  scanId: "s1",
  page: 1,
  dpi: 600,
  scannedAt: T,
  analysedAt: T + 5000,
  found: true,
  dots: 812,
  gridScore: 0.93,
  decode: { manufacturer: "Dell", serial: "123456", timestamp: "2023-11-14 23:13" },
  decodeError: null,
  error: null,
  images: ["overview", "closeRaw", "closeEnhanced", "closeYellow"],
  ...over,
});

const CANDIDATES: DedaCandidate[] = [
  {
    id: "s1",
    createdAt: T,
    pages: [
      { n: 1, dpi: 600, mode: "color", lowDpi: false },
      { n: 2, dpi: 300, mode: "color", lowDpi: true },
    ],
  },
];

/** Answers the Deda API from `analyses` (changed by the handler) and records the calls. */
function fakeApi(initial: DedaView[] = []) {
  let analyses = initial;
  const stub = stubFetch(async (req) => {
    const p = path(req);
    if (req.method === "GET" && p === "/api/analyse/deda") return Response.json({ analyses });
    if (req.method === "GET" && p === "/api/analyse/deda/candidates") return Response.json({ scans: CANDIDATES });
    if (req.method === "POST" && p === "/api/analyse/deda/scan") {
      const v = dedaOf({ id: "d9", status: "scanning", source: "scan", scanId: null, page: null, dpi: null, found: null, decode: null, images: [], scannedAt: T + 9 });
      analyses = [v, ...analyses];
      return Response.json(v, { status: 202 });
    }
    if (req.method === "POST" && p === "/api/analyse/deda") {
      const b = (await req.clone().json()) as { scanId: string; page: number };
      const v = dedaOf({ id: "d8", status: "analysing", scanId: b.scanId, page: b.page, found: null, decode: null, images: [], scannedAt: T + 8 });
      analyses = [v, ...analyses];
      return Response.json(v, { status: 202 });
    }
    if (req.method === "PATCH") {
      const b = (await req.clone().json()) as { name: string };
      const v = { ...analyses.find((a) => p.endsWith(a.id))!, name: b.name };
      analyses = analyses.map((a) => (a.id === v.id ? v : a));
      return Response.json(v);
    }
    if (req.method === "DELETE" && p === "/api/analyse/deda") {
      const removed = analyses.length;
      analyses = [];
      return Response.json({ removed });
    }
    if (req.method === "DELETE") {
      analyses = analyses.filter((a) => !p.endsWith(a.id));
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  });
  return stub;
}

describe("DedaPage", () => {
  test("says when there are no analyses yet", async () => {
    fakeApi();
    renderWithQuery(<DedaPage />);
    expect(screen.getByRole("heading", { name: "Tracking dots (DEDA)" })).toBeTruthy();
    expect(await screen.findByText("No analyses yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear history" })).toBeNull();
  });

  test("Scan page from glass posts and shows the scanning entry", async () => {
    const { calls } = fakeApi();
    renderWithQuery(<DedaPage />);
    await screen.findByText("No analyses yet.");
    await user.click(screen.getByRole("button", { name: "Scan page from glass" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toContain("POST /api/analyse/deda/scan");
    expect(await screen.findByText("Scanning…")).toBeTruthy();
    expect(screen.queryByText("No analyses yet.")).toBeNull();
  });

  test("the History picker lists the candidates, warns on a low-dpi page and posts the chosen page", async () => {
    const { calls } = fakeApi();
    renderWithQuery(<DedaPage />);
    await screen.findByText("No analyses yet.");
    await user.click(screen.getByRole("button", { name: "Pick from History" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toContain("GET /api/analyse/deda/candidates");
    const p1 = await screen.findByRole("button", { name: "Page 1 · 600 dpi" });
    expect(screen.getAllByRole("button", { name: /^Page \d/ })).toHaveLength(2);
    await user.click(p1);
    expect(screen.queryByText("Below 600 dpi the dots are hard to see; results may miss them.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Page 2 · 300 dpi" }));
    expect(screen.getByText("Below 600 dpi the dots are hard to see; results may miss them.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Analyse" }));
    await act(async () => {});
    const post = calls.find((r) => endpoint(r) === "POST /api/analyse/deda")!;
    expect(await post.json()).toEqual({ scanId: "s1", page: 2 });
    expect(await screen.findByText("Analysing…")).toBeTruthy();
    // The sheet closed.
    expect(screen.queryByRole("button", { name: "Page 1 · 600 dpi" })).toBeNull();
  });

  test("renames an entry inline with a PATCH", async () => {
    const { calls } = fakeApi([dedaOf()]);
    renderWithQuery(<DedaPage />);
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(input.value).toBe("Deda scan 2023-11-14 23:13:20");
    await user.clear(input);
    await user.type(input, "Office printer{Enter}");
    await act(async () => {});
    const patch = calls.find((r) => r.method === "PATCH")!;
    expect(endpoint(patch)).toBe("PATCH /api/analyse/deda/d1");
    expect(await patch.json()).toEqual({ name: "Office printer" });
    expect(await screen.findByText("Office printer")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  });

  test("deletes an entry", async () => {
    const { calls } = fakeApi([dedaOf(), dedaOf({ id: "d2", name: "Second" })]);
    renderWithQuery(<DedaPage />);
    await screen.findByText("Second");
    await user.click(screen.getAllByRole("button", { name: "Delete" })[1]!);
    await act(async () => {});
    expect(calls.map(endpoint)).toContain("DELETE /api/analyse/deda/d2");
    await waitFor(() => expect(screen.queryByText("Second")).toBeNull());
    expect(screen.getByText("Deda scan 2023-11-14 23:13:20")).toBeTruthy();
  });

  test("Clear history asks first and clears only after confirming", async () => {
    const { calls } = fakeApi([dedaOf()]);
    renderWithQuery(<DedaPage />);
    await user.click(await screen.findByRole("button", { name: "Clear history" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(calls.filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(screen.getByText("Deda scan 2023-11-14 23:13:20")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear history" }));
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => {});
    expect(calls.filter((r) => r.method === "DELETE").map(endpoint)).toEqual(["DELETE /api/analyse/deda"]);
    expect(await screen.findByText("No analyses yet.")).toBeTruthy();
  });
});

describe("DedaResult", () => {
  test("a finished entry shows the overview, the close-ups and the decode", () => {
    renderWithQuery(<DedaResult analysis={dedaOf()} />);
    const overview = screen.getByRole("img", { name: "Overview of the page" }) as HTMLImageElement;
    expect(overview.getAttribute("src")).toBe("/api/analyse/deda/d1/images/overview");
    expect(overview.getAttribute("loading")).toBe("lazy");
    for (const caption of ["Scan", "Enhanced", "Yellowness"]) expect(screen.getByText(caption)).toBeTruthy();
    expect((screen.getByRole("img", { name: "Close-up: Yellowness" }) as HTMLImageElement).getAttribute("src")).toBe("/api/analyse/deda/d1/images/closeYellow");
    expect(screen.getByRole("row", { name: "serial 123456" })).toBeTruthy();
    expect(screen.getByRole("row", { name: "manufacturer Dell" })).toBeTruthy();
    expect(screen.queryByText("No tracking dots found.")).toBeNull();
  });

  test("found false says no dots were found", () => {
    renderWithQuery(<DedaResult analysis={dedaOf({ found: false, decode: null, images: ["overview"] })} />);
    expect(screen.getByText("No tracking dots found.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("a decode that failed says why; a failed entry shows its error", () => {
    const { rerender } = renderWithQuery(<DedaResult analysis={dedaOf({ decode: null, decodeError: "Pattern not recognised" })} />);
    expect(screen.getByText("Pattern not recognised")).toBeTruthy();
    rerender(<DedaResult analysis={dedaOf({ status: "failed", found: null, decode: null, images: [], error: "Analyse service unreachable" })} />);
    expect(screen.getByText("Analyse service unreachable")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("DedaList", () => {
  test("DedaItem does not re-render when the list re-renders with the same entry", () => {
    // The item reads `name` while rendering; a skipped render doesn't.
    let reads = 0;
    const entry = Object.defineProperty(dedaOf(), "name", {
      get() {
        reads++;
        return "Deda scan 2023-11-14 23:13:20";
      },
    });
    const analyses = [entry];
    const { Wrapped, count } = renderCount(DedaList);
    const { rerender } = renderWithQuery(<Wrapped analyses={analyses} />);
    const first = reads;
    rerender(<Wrapped analyses={analyses} />);
    expect(count()).toBe(2);
    expect(reads).toBe(first);
    // A new entry object (a poll answer that changed it) renders again.
    rerender(<Wrapped analyses={[dedaOf({ name: "New" })]} />);
    expect(screen.getByText("New")).toBeTruthy();
  });

  test("an entry shows when it was scanned and where it came from", () => {
    renderWithQuery(<DedaList analyses={[dedaOf(), dedaOf({ id: "d2", source: "scan", scanId: null, page: null })]} />);
    expect(screen.getAllByText(new Date(T).toLocaleString(), { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("History page 1 · 600 dpi", { exact: false })).toBeTruthy();
    expect(screen.getByText("Scanned from the glass", { exact: false })).toBeTruthy();
  });
});

describe("polling", () => {
  test("dedaPoll polls only while an entry is scanning or analysing", () => {
    expect(dedaPoll([dedaOf({ status: "scanning" })])).toBe(DEDA_POLL_MS);
    expect(dedaPoll([dedaOf(), dedaOf({ status: "analysing" })])).toBe(DEDA_POLL_MS);
    expect(dedaPoll([dedaOf(), dedaOf({ status: "failed" })])).toBe(false);
    expect(dedaPoll(undefined)).toBe(false);
    expect(DEDA_POLL_MS).toBe(2000);
  });

  test("useDedaAnalyses polls while pending and stops once nothing is pending", async () => {
    let answer = [dedaOf({ status: "analysing" })];
    const { calls } = stubFetch(() => Response.json({ analyses: answer }));
    // TanStack decided "server, no timers" when it was first imported, before happy-dom gave it a `window`.
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    try {
      const qc = new QueryClient();
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
      const { result } = renderHook(() => useDedaAnalyses(), { wrapper });
      await waitFor(() => expect(result.current.data).toHaveLength(1));
      // The next poll (2 s later) brings the finished entry; after that nothing is fetched any more.
      answer = [dedaOf()];
      await waitFor(() => expect(result.current.data![0]!.status).toBe("done"), { timeout: 3000 });
      const fetched = calls.length;
      await act(() => new Promise((r) => setTimeout(r, 2300)));
      expect(calls.length).toBe(fetched);
    } finally {
      environmentManager.setIsServer(() => wasServer);
    }
  }, 10_000);
});
