import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import { INITIAL_LIVE } from "../../src/web/helpers/live";
import type { ScanView } from "../../src/web/types/api";
import type { LiveState } from "../../src/web/types/ui";
import { endpoint, FEEDER, noop, OUTPUTS, scanOf as liveScan } from "./fixtures";
import { renderCount, renderWithQuery, screen, stubFetch, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix reads `document` when imported: load every component that imports Radix after happy-dom is registered.
let StatusBadges: typeof import("../../src/web/components/history/StatusBadges").StatusBadges;
let HistoryList: typeof import("../../src/web/components/history/HistoryList").HistoryList;
let ScanDetail: typeof import("../../src/web/components/history/ScanDetail").ScanDetail;
let HistoryPage: typeof import("../../src/web/pages/HistoryPage").HistoryPage;
beforeAll(async () => {
  ({ StatusBadges } = await import("../../src/web/components/history/StatusBadges"));
  ({ HistoryList } = await import("../../src/web/components/history/HistoryList"));
  ({ ScanDetail } = await import("../../src/web/components/history/ScanDetail"));
  ({ HistoryPage } = await import("../../src/web/pages/HistoryPage"));
});

afterEach(() => {
  location.hash = "";
});

const del = (id: number, outputProfileId: number, status: "sent" | "failed", error?: string) => ({
  id,
  outputProfileId,
  outputProfileName: OUTPUTS.find((o) => o.id === outputProfileId)!.name,
  status,
  files: [],
  createdAt: 1_700_000_000_000 + id,
  ...(error ? { error } : {}),
});
/** A finished scan as History lists it: sent to "To folder". */
const scanOf = (over: Partial<ScanView> = {}): ScanView => liveScan({ status: "done", deliveries: [del(1, 1, "sent")], ...over });

const listProps = { outputs: OUTPUTS, selectedId: undefined, error: undefined, loading: false, done: true, onLoadMore: noop, sentinel: { current: null } };

describe("StatusBadges", () => {
  test("StatusBadges shows today's badges", () => {
    const { rerender } = renderWithQuery(<StatusBadges scan={scanOf()} outputs={OUTPUTS} />);
    expect(screen.getByText("sent").className).toContain("badge-ok");
    rerender(<StatusBadges scan={scanOf({ deliveries: [del(1, 1, "sent"), del(2, 2, "failed", "401")] })} outputs={OUTPUTS} />);
    expect(screen.getByText("sent")).toBeTruthy();
    expect(screen.getByText("resend failed").className).toContain("badge-error");
    rerender(<StatusBadges scan={scanOf({ status: "failed", problem: "Paper jam." })} outputs={OUTPUTS} />);
    expect(screen.getByText("failed").className).toContain("badge-error");
    expect(screen.getByText("partial").className).toContain("badge-warn");
    rerender(<StatusBadges scan={scanOf({ status: "ready", deliveries: [] })} outputs={OUTPUTS} />);
    expect(screen.getByText("not sent")).toBeTruthy();
    rerender(<StatusBadges scan={scanOf({ status: "scanning" })} outputs={OUTPUTS} />);
    expect(screen.getByText("scanning").className).toContain("badge-busy");
  });
});

describe("HistoryList", () => {
  test("HistoryRow does not re-render when the list re-renders with the same scan", () => {
    // The row reads `createdAt` while rendering; a skipped render doesn't.
    let reads = 0;
    const scan = Object.defineProperty(scanOf(), "createdAt", {
      get() {
        reads++;
        return 1_700_000_000_000;
      },
    });
    const items = [scan];
    const { Wrapped, count } = renderCount(HistoryList);
    const { rerender } = renderWithQuery(<Wrapped {...listProps} items={items} />);
    const first = reads;
    rerender(<Wrapped {...listProps} items={items} />);
    expect(count()).toBe(2);
    expect(reads).toBe(first);
    // Selecting the row changes its props: it renders again.
    rerender(<Wrapped {...listProps} items={items} selectedId="s1" />);
    expect(reads).toBeGreaterThan(first);
  });

  test("HistoryRow shows a live status change", () => {
    const { rerender } = renderWithQuery(<HistoryList {...listProps} items={[scanOf({ status: "scanning", deliveries: [] })]} />);
    expect(screen.getByText("scanning")).toBeTruthy();
    // The socket sent a new object for the same scan id.
    rerender(<HistoryList {...listProps} items={[scanOf({ status: "done" })]} />);
    expect(screen.queryByText("scanning")).toBeNull();
    expect(screen.getByText("sent")).toBeTruthy();
  });

  test("HistoryList marks the selected scan and offers Load more", async () => {
    const onLoadMore = mock(noop);
    renderWithQuery(<HistoryList {...listProps} items={[scanOf(), scanOf({ id: "s2" })]} selectedId="s2" done={false} onLoadMore={onLoadMore} />);
    expect(screen.getAllByRole("link")[1]!.getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByRole("link")[0]!.getAttribute("href")).toBe("#/history/s1");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("HistoryList says when there are no scans and shows an error", () => {
    const { rerender } = renderWithQuery(<HistoryList {...listProps} items={[]} />);
    expect(screen.getByText("No scans yet.")).toBeTruthy();
    rerender(<HistoryList {...listProps} items={[]} error="Offline" loading />);
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.queryByText("No scans yet.")).toBeNull();
  });
});

describe("ScanDetail", () => {
  test("ScanDetail offers resend for a failed delivery", async () => {
    const scan = scanOf({ status: "failed", deliveries: [del(1, 1, "failed", "SMB down")] });
    const sent = scanOf({ deliveries: [del(1, 1, "failed", "SMB down"), del(2, 1, "sent")] });
    const { calls } = stubFetch(() => Response.json(sent));
    const onUpdate = mock(noop);
    renderWithQuery(<ScanDetail scan={scan} outputs={OUTPUTS} desktop={false} onUpdate={onUpdate} onDeleted={noop} />);
    expect(screen.getByText("SMB down")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Resend" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["POST /api/scans/s1/resend"]);
    expect(await calls[0]!.json()).toEqual({ outputProfileId: 1 });
    expect(onUpdate).toHaveBeenCalledWith(sent);
  });

  test("ScanDetail deletes after confirming and reports the id", async () => {
    const { calls } = stubFetch(() => new Response(null, { status: 204 }));
    const onDeleted = mock(noop);
    renderWithQuery(<ScanDetail scan={scanOf()} outputs={OUTPUTS} desktop onUpdate={noop} onDeleted={onDeleted} />);
    await user.click(screen.getByRole("button", { name: "Delete scan" }));
    expect(calls.length).toBe(0);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["DELETE /api/scans/s1"]);
    expect(onDeleted).toHaveBeenCalledWith("s1");
  });
});

describe("HistoryPage", () => {
  const live = (dispatch = noop) => ({ state: INITIAL_LIVE as LiveState, dispatch, status: INITIAL_LIVE.status }) as never;
  const profiles = { inputs: [FEEDER], outputs: OUTPUTS, loaded: true };

  test("after delete the page navigates away before forgetting the scan, with no request for it", async () => {
    const dispatch = mock(noop);
    const { calls } = stubFetch((req) => (req.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json([scanOf()])));
    location.hash = "#/history/s1";
    renderWithQuery(<HistoryPage live={live(dispatch)} profiles={profiles} />);
    await user.click(await screen.findByRole("button", { name: "Delete scan" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await act(async () => {});
    expect(dispatch).toHaveBeenCalledWith({ type: "forget", id: "s1" });
    expect(location.hash).toBe("#/history");
    // The deep link was fetched while the list loaded; after the DELETE the page asks for nothing.
    const afterDelete = calls.slice(calls.findIndex((r) => r.method === "DELETE") + 1);
    expect(afterDelete.map(endpoint)).toEqual([]);
  });
});
