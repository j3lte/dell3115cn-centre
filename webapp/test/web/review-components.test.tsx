import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { DEFAULT_FILTER } from "../../src/web/helpers/filter";
import type { Filter, ScanView } from "../../src/web/types/api";
import type { PageActions } from "../../src/web/types/ui";
import { endpoint, FEEDER, noop, OUTPUTS, page, scanOf } from "./fixtures";
import { renderWithQuery, screen, stubFetch, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix reads `document` when imported: load every component that imports Radix after happy-dom is registered.
let FilterPanel: typeof import("../../src/web/components/filter/FilterPanel").FilterPanel;
let PageTools: typeof import("../../src/web/components/scan/PageTools").PageTools;
let PageFilter: typeof import("../../src/web/components/scan/PageFilter").PageFilter;
let ReviewStage: typeof import("../../src/web/components/scan/ReviewStage").ReviewStage;
let ReviewPageList: typeof import("../../src/web/components/scan/ReviewPageList").ReviewPageList;
let ReviewControls: typeof import("../../src/web/components/scan/ReviewControls").ReviewControls;
beforeAll(async () => {
  ({ FilterPanel } = await import("../../src/web/components/filter/FilterPanel"));
  ({ PageTools } = await import("../../src/web/components/scan/PageTools"));
  ({ PageFilter } = await import("../../src/web/components/scan/PageFilter"));
  ({ ReviewStage } = await import("../../src/web/components/scan/ReviewStage"));
  ({ ReviewPageList } = await import("../../src/web/components/scan/ReviewPageList"));
  ({ ReviewControls } = await import("../../src/web/components/scan/ReviewControls"));
});

const BW: Filter = { ...DEFAULT_FILTER, preset: "bw" };
const review = (over: Partial<ScanView> = {}) => scanOf({ status: "review", review: true, pages: [page(1), page(2), page(3)], ...over });
const pageActions = () => ({
  move: mock((_from: number, _to: number) => {}),
  rotate: mock((_n: number) => {}),
  remove: mock((_n: number) => {}),
  setFilter: mock((_n: number, _f: Filter | null) => {}),
}) satisfies PageActions;

describe("FilterPanel", () => {
  const restore: (() => void)[] = [];
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  test("FilterPanel keeps a slider's value as a draft and saves it on release", () => {
    // happy-dom has no pointer capture and lays nothing out: the slider is 200 px wide at x = 0.
    for (const [key, value] of [
      ["setPointerCapture", noop],
      ["releasePointerCapture", noop],
      ["hasPointerCapture", () => true],
    ] as const) {
      const old = Object.getOwnPropertyDescriptor(Element.prototype, key);
      Object.defineProperty(Element.prototype, key, { configurable: true, value });
      restore.push(() => (old ? Object.defineProperty(Element.prototype, key, old) : delete (Element.prototype as never as Record<string, unknown>)[key]));
    }
    const onChange = mock((_f: Filter) => {});
    render(<FilterPanel value={DEFAULT_FILTER} onChange={onChange} />);
    const thumb = screen.getByRole("slider", { name: "Brightness" });
    const root = thumb.closest(".touch-none") as HTMLElement;
    root.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20, x: 0, y: 0, toJSON: noop }) as DOMRect;
    // -100…100 over 200 px: x = 150 is +50, x = 160 is +60.
    fireEvent.pointerDown(root, { clientX: 150, pointerId: 1 });
    fireEvent.pointerMove(root, { clientX: 160, pointerId: 1 });
    expect(thumb.getAttribute("aria-valuenow")).toBe("60");
    expect(within(root.parentElement!).getByText("60").tagName).toBe("OUTPUT");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(root, { clientX: 160, pointerId: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTER, brightness: 60 });
  });

  test("FilterPanel saves a preset at once and shows Threshold only for black and white", async () => {
    const onChange = mock((_f: Filter) => {});
    const { rerender } = render(<FilterPanel value={DEFAULT_FILTER} onChange={onChange} />);
    expect(screen.queryByRole("slider", { name: "Threshold" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Black & white" }));
    expect(onChange).toHaveBeenCalledWith(BW);
    rerender(<FilterPanel value={BW} onChange={onChange} />);
    expect(screen.getByRole("slider", { name: "Threshold" })).toBeTruthy();
  });
});

describe("PageTools", () => {
  test("PageTools can't move the first page earlier or the last page later", async () => {
    const actions = pageActions();
    const { rerender } = render(<PageTools n={1} count={3} size="row" desktop={false} locked={false} actions={actions} />);
    expect(screen.getByRole("button", { name: "Move page 1 earlier" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Move page 1 later" }).textContent).toBe("↓");
    await user.click(screen.getByRole("button", { name: "Move page 1 later" }));
    expect(actions.move).toHaveBeenCalledWith(1, 2);
    await user.click(screen.getByRole("button", { name: "Rotate page 1" }));
    expect(actions.rotate).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("button", { name: "Delete page 1" }));
    expect(actions.remove).toHaveBeenCalledWith(1);

    rerender(<PageTools n={3} count={3} size="bar" desktop locked={false} actions={actions} />);
    expect(screen.getByRole("button", { name: "Move page 3 later" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Move page 3 earlier" }).textContent).toBe("←");
    await user.click(screen.getByRole("button", { name: "Move page 3 earlier" }));
    expect(actions.move).toHaveBeenLastCalledWith(3, 2);

    rerender(<PageTools n={2} count={3} size="bar" desktop locked actions={actions} />);
    expect(screen.getAllByRole("button").every((b: HTMLElement) => b.hasAttribute("disabled"))).toBe(true);
  });
});

describe("PageFilter", () => {
  test('PageFilter offers "Use scan filter" only for a page with its own filter', async () => {
    const actions = pageActions();
    const scan = review({ pages: [page(1), { ...page(2), filter: BW }] });
    const { rerender } = render(<PageFilter scan={scan} n={1} locked={false} actions={actions} />);
    expect(screen.getByText("Uses the scan filter: Original")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use scan filter" }).hasAttribute("disabled")).toBe(true);

    rerender(<PageFilter scan={scan} n={2} locked={false} actions={actions} />);
    expect(screen.getByText("Own filter: Black & white")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use scan filter" }));
    expect(actions.setFilter).toHaveBeenCalledWith(2, null);

    rerender(<PageFilter scan={scan} n={2} locked actions={actions} />);
    expect(screen.getByRole("button", { name: "Use scan filter" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("ReviewStage", () => {
  test("ReviewStage moves a dragged thumbnail to where it is dropped", () => {
    const actions = pageActions();
    const item = (n: number) => screen.getByRole("button", { name: `Page ${n}` }).closest("li")!;
    const { rerender } = render(<ReviewStage scan={review()} busy={false} locked={false} selected={1} onSelect={noop} actions={actions} />);
    fireEvent.dragStart(item(3));
    expect(item(3).className).toContain("opacity-40");
    fireEvent.dragOver(item(1));
    fireEvent.drop(item(1));
    expect(actions.move).toHaveBeenCalledTimes(1);
    expect(actions.move).toHaveBeenCalledWith(3, 1);
    expect(item(3).className).not.toContain("opacity-40");

    // While the scan is busy the thumbnails can't be dragged.
    rerender(<ReviewStage scan={review()} busy={false} locked selected={1} onSelect={noop} actions={actions} />);
    expect(item(1).getAttribute("draggable")).toBe("false");
  });
});

describe("ReviewPageList", () => {
  test("ReviewPageList opens a tapped page in a sheet", async () => {
    // The open page is the tray's state; here a stand-in holds it.
    function Tray() {
      const [open, setOpen] = useState<number | null>(null);
      return <ReviewPageList scan={review()} busy={false} locked={false} actions={pageActions()} sheetPage={open} onSheetPage={setOpen} />;
    }
    render(<Tray />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Page 2: open" }));
    const sheet = screen.getByRole("dialog", { name: "Page 2" });
    expect(within(sheet).getByRole("img", { name: "Page 2" }).getAttribute("src")).toBe("/v/2.png");
    expect(within(sheet).getByRole("button", { name: "Use scan filter" })).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ReviewControls", () => {
  /** A tray `run` that records the action label and runs it. */
  const runner = () => {
    const labels: string[] = [];
    const run = (label: string) => async (fn: () => Promise<ScanView>) => {
      labels.push(label);
      await fn();
    };
    return { labels, run };
  };
  const controls = (scan: ScanView, over: { scannerReady?: string | null; locked?: boolean } = {}) => {
    const { labels, run } = runner();
    const { calls } = stubFetch(() => Response.json(scan));
    renderWithQuery(<ReviewControls scan={scan} outputs={OUTPUTS} scannerReady={over.scannerReady ?? null} busy={null} locked={over.locked ?? false} run={run} />);
    return { labels, calls };
  };

  test("ReviewControls discards only after confirming", async () => {
    const { labels, calls } = controls(review());
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("dialog", { name: "Discard this scan?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(calls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["POST /api/scans/s1/cancel"]);
    expect(labels).toEqual(["cancel"]);
  });

  test("ReviewControls scans more, or says why the scanner can't", async () => {
    const { labels, calls } = controls(review());
    await user.click(screen.getByRole("button", { name: "Scan more" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["POST /api/scans/s1/more"]);
    expect(labels).toEqual(["more"]);
    cleanup();

    controls(review({ inputProfile: { ...FEEDER, source: "flatbed" } }), { scannerReady: "Scanner is off" });
    expect(screen.getByRole("button", { name: "Scan next page" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Scanner is off")).toBeTruthy();
  });

  test("ReviewControls sends only once an output profile is chosen", async () => {
    const { calls } = controls(review({ outputProfileId: null }));
    const select = screen.getByRole("combobox", { name: "Send to" }) as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toBe("Choose an output profile");
    expect(screen.getByRole("button", { name: "Send 3 pages" }).hasAttribute("disabled")).toBe(true);
    await user.selectOptions(select, "2");
    await user.click(screen.getByRole("button", { name: "Send 3 pages" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["POST /api/scans/s1/send"]);
    expect(await calls[0]!.json()).toEqual({ outputProfileId: 2 });
  });

  test("ReviewControls keeps a deleted output profile as the choice", () => {
    controls(review({ outputProfileId: 99 }));
    const select = screen.getByRole("combobox", { name: "Send to" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["(deleted profile)", "To folder", "Paperless"]);
    expect(select.value).toBe("99");
  });
});
