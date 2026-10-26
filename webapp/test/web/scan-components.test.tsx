import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { INITIAL_LIVE } from "../../src/web/helpers/live";
import { GLASS_MM, regionToMm } from "../../src/web/helpers/region";
import type { AreaMm, InputProfile, OutputProfile, ScanView } from "../../src/web/types/api";
import type { Live } from "../../src/web/hooks/useLive";
import type { LiveState } from "../../src/web/types/ui";
import { FEEDER, noop, OUTPUTS, page, path, scanOf } from "./fixtures";
import { renderCount, renderWithQuery, screen, stubFetch, stubMedia, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix reads `document` when imported: load every component that imports Radix after happy-dom is registered.
let ScanResult: typeof import("../../src/web/components/scan/ScanResult").ScanResult;
let PageStrip: typeof import("../../src/web/components/scan/PageStrip").PageStrip;
let PageThumb: typeof import("../../src/web/components/scan/PageThumb").PageThumb;
let PreviewRegion: typeof import("../../src/web/components/scan/PreviewRegion").PreviewRegion;
let ReviewTray: typeof import("../../src/web/components/scan/ReviewTray").ReviewTray;
let ScanPage: typeof import("../../src/web/pages/ScanPage").ScanPage;
let ScanForm: typeof import("../../src/web/components/scan/ScanForm").ScanForm;
let PendingReview: typeof import("../../src/web/components/scan/PendingReview").PendingReview;
let DownloadList: typeof import("../../src/web/components/scan/DownloadList").DownloadList;
beforeAll(async () => {
  ({ ScanResult } = await import("../../src/web/components/scan/ScanResult"));
  ({ PageStrip } = await import("../../src/web/components/scan/PageStrip"));
  ({ PageThumb } = await import("../../src/web/components/scan/PageThumb"));
  ({ PreviewRegion } = await import("../../src/web/components/scan/PreviewRegion"));
  ({ ReviewTray } = await import("../../src/web/components/scan/ReviewTray"));
  ({ ScanPage } = await import("../../src/web/pages/ScanPage"));
  ({ ScanForm } = await import("../../src/web/components/scan/ScanForm"));
  ({ PendingReview } = await import("../../src/web/components/scan/PendingReview"));
  ({ DownloadList } = await import("../../src/web/components/scan/DownloadList"));
});

afterEach(() => {
  location.hash = "";
  localStorage.clear();
});

/** The live connection as ScanPage gets it, holding one scan; the scanner is ready. */
const liveWith = (scan: ScanView, paperInFeeder = true) =>
  ({
    state: { ...INITIAL_LIVE, connected: true, status: { service: "connected", printer: "idle", paperInFeeder }, scans: { [scan.id]: scan } } as LiveState,
    dispatch: noop,
    reconnect: noop,
  }) satisfies Live;
const profiles = { inputs: [FEEDER], outputs: OUTPUTS, loaded: true };

describe("ScanResult", () => {
  test("ScanResult shows each progress update", () => {
    const { rerender } = renderWithQuery(<ScanResult scan={scanOf({ pages: [page(1)] })} outputs={OUTPUTS} onDismiss={noop} />);
    expect(screen.getByRole("heading").textContent).toBe("Scanning page 2…");
    expect(screen.getAllByRole("img").length).toBe(1);
    // The same scan id with the socket's next message: a fresh object with one more page.
    rerender(<ScanResult scan={scanOf({ pages: [page(1), page(2)] })} outputs={OUTPUTS} onDismiss={noop} />);
    expect(screen.getByRole("heading").textContent).toBe("Scanning page 3…");
    expect(screen.getAllByRole("img").length).toBe(2);
    rerender(<ScanResult scan={scanOf({ status: "ready", pages: [page(1), page(2)] })} outputs={OUTPUTS} onDismiss={noop} />);
    expect(screen.getByRole("heading").textContent).toBe("2 pages scanned by an assistant, not sent");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("ScanResult does not re-render when the page re-renders with the same scan", () => {
    // Only ScanResult reads `problem` (through ProblemLine) while rendering; a skipped render doesn't.
    let reads = 0;
    const scan = Object.defineProperty(scanOf({ status: "done" }), "problem", {
      get() {
        reads++;
        return undefined;
      },
    });
    const live = (paperInFeeder: boolean) => liveWith(scan, paperInFeeder);
    stubFetch(() => Response.json({}));
    const { Wrapped, count } = renderCount(ScanPage);
    const { rerender } = renderWithQuery(<Wrapped live={live(false)} profiles={profiles} />);
    expect(screen.getByRole("heading", { name: "✓ Sent 1 page to To folder" })).toBeTruthy();
    const first = reads;
    // A status message from the socket: the page re-renders, the scan is the same object.
    rerender(<Wrapped live={live(true)} profiles={profiles} />);
    expect(count()).toBe(2);
    expect(reads).toBe(first);
  });
});

describe("ScanPage", () => {
  beforeEach(() => void stubFetch(() => Response.json({})));
  const sent = "✓ Sent 1 page to To folder";

  test("Dismiss hides the finished scan, also after a reload", async () => {
    const scan = scanOf({ id: "done-1", status: "done" });
    const { unmount } = renderWithQuery(<ScanPage live={liveWith(scan)} profiles={profiles} />);
    expect(screen.getByRole("heading", { name: sent })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("heading", { name: sent })).toBeNull();
    expect(localStorage.getItem("scan.dismissed")).toBe("done-1");
    unmount();
    renderWithQuery(<ScanPage live={liveWith(scan)} profiles={profiles} />);
    expect(screen.queryByRole("heading", { name: sent })).toBeNull();
  });

  test("Dismiss on a chosen scan goes back to the Scan page", async () => {
    location.hash = "#/scan/done-1";
    renderWithQuery(<ScanPage live={liveWith(scanOf({ id: "done-1", status: "done" }))} profiles={profiles} />);
    expect(screen.getByRole("heading", { name: sent })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(location.hash).toBe("#/scan");
  });
});

describe("PageStrip", () => {
  /**
   * The props each mounted PageThumb last rendered with, from React's committed fiber tree: a memoized component that
   * skips a render keeps its old props object, one that renders gets the new one.
   */
  const thumbProps = (container: HTMLElement): object[] => {
    type Fiber = { elementType: unknown; memoizedProps: object; child: Fiber | null; sibling: Fiber | null };
    const key = Object.keys(container).find((k) => k.startsWith("__reactContainer$"))!;
    const found: object[] = [];
    const stack: Fiber[] = [(container as never as Record<string, { stateNode: { current: Fiber } }>)[key]!.stateNode.current];
    while (stack.length) {
      const f = stack.pop()!;
      if (f.elementType === PageThumb) found.push(f.memoizedProps);
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return found;
  };
  const same = (a: object[], b: object[]) => a.map((p, i) => p === b[i]);

  test("PageThumb does not re-render when the socket brings equal pages", () => {
    const strip = (selected: number, third = page(3)) => <PageStrip scan={scanOf({ pages: [page(1), page(2), third] })} selected={selected} onSelect={noop} />;
    const { container, rerender } = render(strip(1));
    const first = thumbProps(container);
    expect(first.length).toBe(3);
    // The socket's next message: a fresh scan with fresh page objects that show the same.
    rerender(strip(1));
    const second = thumbProps(container);
    expect(same(second, first)).toEqual([true, true, true]);
    // Selecting page 2 re-renders the old and the new selection only.
    rerender(strip(2));
    const third = thumbProps(container);
    expect(same(third, second)).toEqual([false, false, true]);
    // A new thumbnail for page 3 re-renders that thumb.
    rerender(strip(2, { ...page(3), thumbUrl: "/t/3b.png" }));
    expect(same(thumbProps(container), third)).toEqual([true, true, false]);
    expect(screen.getByRole("img", { name: "Page 3" }).getAttribute("src")).toBe("/t/3b.png");
  });

  test("PageStrip reports the clicked page", async () => {
    const onSelect = mock((_n: number) => {});
    render(<PageStrip scan={scanOf({ pages: [page(1), page(2)] })} selected={1} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Page 2" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});

describe("ReviewTray", () => {
  test("ReviewTray sends with the chosen output profile", async () => {
    const scan = scanOf({ status: "review", review: true, pages: [page(1), page(2)] });
    const sent = { ...scan, status: "delivering" as const, outputProfileId: 2 };
    const bodies: unknown[] = [];
    const stub = stubFetch(async (req) => {
      if (req.method === "POST" && path(req) === `/api/scans/${scan.id}/send`) {
        bodies.push(await req.clone().json());
        return Response.json(sent);
      }
      return Response.json({});
    });
    const onUpdate = mock((_v: ScanView) => {});
    renderWithQuery(<ReviewTray scan={scan} outputs={OUTPUTS} scannerReady={null} onUpdate={onUpdate} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Send to" }), "2");
    await user.click(screen.getByRole("button", { name: "Send 2 pages" }));
    await act(async () => {});
    expect(stub.calls.filter((r) => r.method === "POST").map(path)).toEqual([`/api/scans/${scan.id}/send`]);
    expect(bodies).toEqual([{ outputProfileId: 2 }]);
    expect(onUpdate).toHaveBeenCalledWith(sent);
  });

  test("ReviewTray keeps the open page when the window crosses the desktop breakpoint", async () => {
    stubFetch(() => Response.json({}));
    const media = stubMedia(false);
    const scan = scanOf({ status: "review", review: true, pages: [page(1), page(2)] });
    renderWithQuery(<ReviewTray scan={scan} outputs={OUTPUTS} scannerReady={null} onUpdate={noop} />);
    await user.click(screen.getByRole("button", { name: "Page 2: open" }));
    expect(screen.getByRole("dialog", { name: "Page 2" })).toBeTruthy();
    act(() => media.set(true));
    expect(screen.getByRole("button", { name: "Page 2" }).getAttribute("aria-pressed")).toBe("true");
    act(() => media.set(false));
    expect(screen.getByRole("dialog", { name: "Page 2" })).toBeTruthy();
  });

  test("the reopened sheet shows the page selected meanwhile, never a removed one", async () => {
    stubFetch(() => Response.json({}));
    const media = stubMedia(false);
    const three = scanOf({ status: "review", review: true, pages: [page(1), page(2), page(3)] });
    const { rerender } = renderWithQuery(<ReviewTray scan={three} outputs={OUTPUTS} scannerReady={null} onUpdate={noop} />);
    await user.click(screen.getByRole("button", { name: "Page 3: open" }));
    act(() => media.set(true));
    // On the desktop, page 3 is removed: the selection falls back to the last page.
    rerender(<ReviewTray scan={{ ...three, pages: [page(1), page(2)] }} outputs={OUTPUTS} scannerReady={null} onUpdate={noop} />);
    act(() => media.set(false));
    expect(screen.getByRole("dialog", { name: "Page 2" })).toBeTruthy();
    act(() => media.set(true));
    await user.click(screen.getByRole("button", { name: "Page 1" }));
    act(() => media.set(false));
    expect(screen.getByRole("dialog", { name: "Page 1" })).toBeTruthy();
  });
});

describe("PreviewRegion", () => {
  // The preview image is 10 px per mm of glass; on screen it is shown at a quarter of that.
  const IMG = { width: GLASS_MM.w * 10, height: GLASS_MM.h * 10 };
  const BOX = { left: 0, top: 0, width: IMG.width / 4, height: IMG.height / 4 };
  const restore: (() => void)[] = [];
  const stubProperty = (proto: object, key: string, desc: PropertyDescriptor) => {
    const old = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, ...desc });
    restore.push(() => (old ? Object.defineProperty(proto, key, old) : delete (proto as Record<string, unknown>)[key]));
  };
  beforeEach(() => {
    // happy-dom decodes no images and lays nothing out.
    stubProperty(HTMLImageElement.prototype, "naturalWidth", { get: () => IMG.width });
    stubProperty(HTMLImageElement.prototype, "naturalHeight", { get: () => IMG.height });
    stubProperty(HTMLImageElement.prototype, "decode", { value: () => Promise.resolve() });
    stubProperty(Element.prototype, "setPointerCapture", { value: noop });
    stubProperty(URL, "createObjectURL", { value: () => "blob:preview" });
    stubProperty(URL, "revokeObjectURL", { value: noop });
  });
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  test("PreviewRegion turns a drag into millimetres", async () => {
    stubFetch((req) => (path(req) === "/api/preview" ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }) : Response.json({})));
    const onScanArea = mock(async (_a: AreaMm) => {});
    renderWithQuery(<PreviewRegion disabledReason={null} onScanArea={onScanArea} onClose={noop} />);
    await user.click(screen.getByRole("button", { name: "Run preview" }));
    await screen.findByRole("img", { name: "Preview of the scanner glass" });
    const box = screen.getByTestId("preview-box");
    box.getBoundingClientRect = () => ({ ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON: noop }) as DOMRect;
    // On screen (25, 50) → (225, 350) is (100, 200) → (900, 1400) in preview pixels.
    fireEvent.pointerDown(box, { clientX: 25, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(box, { clientX: 225, clientY: 350, pointerId: 1 });
    fireEvent.pointerUp(box, { clientX: 225, clientY: 350, pointerId: 1 });
    const area = regionToMm({ x: 100, y: 200, w: 800, h: 1200 }, IMG);
    expect(area).toEqual([10, 20, 80, 120]);
    expect(screen.getByText("Area 80 × 120 mm")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Scan area" }));
    expect(onScanArea).toHaveBeenCalledWith(area);
  });
});

describe("ScanForm", () => {
  const FLATBED: InputProfile = { ...FEEDER, id: 2, name: "Glass", source: "flatbed", paper: "glass" };
  const MULTI = { ...OUTPUTS[1]!, format: "pdf_multi" } as OutputProfile;
  const profiles = { inputs: [FEEDER, FLATBED], outputs: OUTPUTS, loaded: true };
  const choice = (input = FEEDER, output: OutputProfile = OUTPUTS[0]!) => ({ input, output, review: false, setInputId: mock((_id: number) => {}), setOutputId: mock((_id: number) => {}), setReview: mock((_v: boolean) => {}) });
  const starter = (over: { starting?: boolean; error?: string } = {}) => ({ starting: false, error: undefined as string | undefined, start: mock(async () => {}), startArea: mock(async (_a: AreaMm) => {}), ...over });
  const form = (over: Partial<Parameters<typeof ScanForm>[0]> = {}) => (
    <ScanForm profiles={profiles} choice={choice()} starter={starter()} reason={null} noPaper={false} busy={false} previewing={false} onPreviewingChange={noop} {...over} />
  );

  test("ScanForm says why Scan is disabled, and starts when it can", async () => {
    const { rerender } = render(form({ reason: "Create an input and an output profile first (Profiles tab)", noPaper: true }));
    expect(screen.getByRole("button", { name: "Scan" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Create an input and an output profile first (Profiles tab)")).toBeTruthy();
    expect(screen.getByText("No paper detected in the feeder.")).toBeTruthy();

    const s = starter();
    rerender(form({ starter: s }));
    expect(screen.queryByText("No paper detected in the feeder.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan" }));
    expect(s.start).toHaveBeenCalledTimes(1);

    rerender(form({ starter: starter({ starting: true }) }));
    expect(screen.getByRole("button", { name: "Starting…" }).hasAttribute("disabled")).toBe(true);
    rerender(form({ starter: starter({ error: "The scanner is busy" }) }));
    expect(screen.getByRole("alert").textContent).toBe("The scanner is busy");
  });

  test("ScanForm reports the chosen profiles and explains flatbed to a multi-page PDF", async () => {
    const c = choice(FLATBED, MULTI);
    render(form({ choice: c, profiles: { ...profiles, outputs: [OUTPUTS[0]!, MULTI] } }));
    expect(screen.getByText("Flatbed to a multi-page PDF opens the review tray: scan page by page.")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Input profile" }), "1");
    expect(c.setInputId).toHaveBeenCalledWith(1);
    await user.selectOptions(screen.getByRole("combobox", { name: "Output profile" }), "1");
    expect(c.setOutputId).toHaveBeenCalledWith(1);
    await user.click(screen.getByRole("switch", { name: "Review before sending" }));
    expect(c.setReview).toHaveBeenCalledWith(true);
  });

  test("ScanForm offers Preview only for the flatbed and toggles it", async () => {
    const onPreviewingChange = mock((_v: boolean) => {});
    const { rerender } = render(form({ onPreviewingChange }));
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    rerender(form({ choice: choice(FLATBED), onPreviewingChange }));
    const preview = screen.getByRole("button", { name: "Preview" });
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    await user.click(preview);
    expect(onPreviewingChange).toHaveBeenLastCalledWith(true);
    rerender(form({ choice: choice(FLATBED), previewing: true, onPreviewingChange }));
    expect(preview.getAttribute("aria-pressed")).toBe("true");
    await user.click(preview);
    expect(onPreviewingChange).toHaveBeenLastCalledWith(false);
    rerender(form({ choice: choice(FLATBED), busy: true, onPreviewingChange }));
    expect(preview.hasAttribute("disabled")).toBe(true);
  });
});

describe("PendingReview", () => {
  test("PendingReview links each waiting scan to the tray, open when there is one", () => {
    const waiting = (id: string, status: ScanView["status"]) => scanOf({ id, status, review: true, pages: [page(1), page(2)] });
    const { container, rerender } = render(<PendingReview scans={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<PendingReview scans={[waiting("a/1", "review")]} />);
    expect(container.querySelector("details")!.open).toBe(true);
    expect(screen.getByText(/Pending review \(1\)/)).toBeTruthy();
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("#/scan/a%2F1");
    expect(link.textContent).toContain("2 pages · Letters");
    expect(link.textContent).toEndWith("Open");
    rerender(<PendingReview scans={[waiting("a/1", "review"), waiting("b", "scanning")]} />);
    expect(container.querySelector("details")!.open).toBe(false);
    expect(screen.getAllByRole("link").map((a: HTMLElement) => a.textContent!.endsWith("Scanning…"))).toEqual([false, true]);
  });
});

describe("DownloadList", () => {
  const FILES = [
    { name: "a.pdf", url: "/f/a" },
    { name: "b.pdf", url: "/f/b" },
  ];

  test("DownloadList links each file and downloads them all on request", async () => {
    const clicks: string[] = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.getAttribute("href")!);
    };
    try {
      render(<DownloadList files={FILES} downloadAll />);
      const links = screen.getAllByRole("link");
      expect(links.map((a: HTMLElement) => [a.textContent, a.getAttribute("href"), a.getAttribute("download"), a.className])).toEqual([
        ["↓ a.pdf", "/f/a", "a.pdf", "btn justify-start"],
        ["↓ b.pdf", "/f/b", "b.pdf", "btn justify-start"],
      ]);
      await user.click(screen.getByRole("button", { name: "Download all" }));
      // One download every 400 ms.
      await Bun.sleep(450);
      expect(clicks).toEqual(["/f/a", "/f/b"]);
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
  });

  test("DownloadList offers Download all only for several files, and small buttons when asked", () => {
    const { container, rerender } = render(<DownloadList files={FILES.slice(0, 1)} downloadAll />);
    expect(screen.queryByRole("button", { name: "Download all" })).toBeNull();
    rerender(<DownloadList files={FILES} small />);
    expect(screen.queryByRole("button", { name: "Download all" })).toBeNull();
    expect(screen.getAllByRole("link").map((a: HTMLElement) => a.className)).toEqual(["btn btn-sm justify-start", "btn btn-sm justify-start"]);
    rerender(<DownloadList files={[]} downloadAll />);
    expect(container.innerHTML).toBe("");
  });
});
