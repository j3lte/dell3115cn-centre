import { beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { INITIAL_LIVE } from "../../src/web/helpers/live";
import { ROUTES, visibleRoutes } from "../../src/web/helpers/routes";
import { noop } from "./fixtures";
import { renderWithQuery, screen, stubFetch, useDom } from "./setup";

useDom();

let AnalysePage: typeof import("../../src/web/pages/AnalysePage").AnalysePage;
let BottomNav: typeof import("../../src/web/components/layout/BottomNav").BottomNav;
let Sidebar: typeof import("../../src/web/components/layout/Sidebar").Sidebar;
let useFeatures: typeof import("../../src/web/hooks/useFeatures").useFeatures;
let useRoute: typeof import("../../src/web/hooks/useRoute").useRoute;
beforeAll(async () => {
  ({ AnalysePage } = await import("../../src/web/pages/AnalysePage"));
  ({ BottomNav } = await import("../../src/web/components/layout/BottomNav"));
  ({ Sidebar } = await import("../../src/web/components/layout/Sidebar"));
  ({ useFeatures } = await import("../../src/web/hooks/useFeatures"));
  ({ useRoute } = await import("../../src/web/hooks/useRoute"));
});

const hrefs = () => screen.getAllByRole("link").map((a: HTMLElement) => a.getAttribute("href"));

describe("visibleRoutes", () => {
  test("Analyse comes after History, and only when the feature is on", () => {
    expect(visibleRoutes({ analyse: true })).toEqual(["scan", "history", "analyse", "printer", "profiles", "settings"]);
    expect(visibleRoutes({ analyse: false })).toEqual(["scan", "history", "printer", "profiles", "settings"]);
  });
});

describe("navigation", () => {
  test("Sidebar lists Analyse only when it is among the routes", () => {
    const { rerender } = renderWithQuery(<Sidebar state={INITIAL_LIVE} onConnect={noop} route="scan" routes={visibleRoutes({ analyse: false })} dot={null} printerError={null} />);
    expect(screen.queryByRole("link", { name: "Analyse" })).toBeNull();
    rerender(<Sidebar state={INITIAL_LIVE} onConnect={noop} route="scan" routes={ROUTES} dot={null} printerError={null} />);
    expect(screen.getByRole("link", { name: "Analyse" }).getAttribute("href")).toBe("#/analyse");
  });

  test("the phone bottom bar has 6 columns with Analyse and 5 without", () => {
    const { container, rerender } = renderWithQuery(<BottomNav route="scan" routes={ROUTES} dot={null} />);
    expect(container.querySelector("nav")!.className).toContain("grid-cols-6");
    expect(hrefs()).toHaveLength(6);
    rerender(<BottomNav route="scan" routes={visibleRoutes({ analyse: false })} dot={null} />);
    expect(container.querySelector("nav")!.className).toContain("grid-cols-5");
    expect(container.querySelector("nav")!.className).not.toContain("grid-cols-6");
    expect(hrefs()).toHaveLength(5);
  });

  test("#/analyse falls back to Scan when Analyse is not offered", () => {
    location.hash = "#/analyse/deda";
    expect(renderHook(() => useRoute(visibleRoutes({ analyse: false }))).result.current).toBe("scan");
    expect(renderHook(() => useRoute(ROUTES)).result.current).toBe("analyse");
  });
});

describe("useFeatures", () => {
  test("is off until the server answers, then follows it", async () => {
    stubFetch(() => Response.json({ analyse: true }));
    const client = new QueryClient();
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useFeatures(), { wrapper: wrap });
    expect(result.current).toEqual({ analyse: false });
    await waitFor(() => expect(result.current).toEqual({ analyse: true }));
  });
});

describe("AnalysePage", () => {
  test("#/analyse opens Tracking dots (DEDA)", async () => {
    location.hash = "#/analyse";
    renderWithQuery(<AnalysePage />);
    await waitFor(() => expect(location.hash).toBe("#/analyse/deda"));
    await waitFor(() => expect(screen.getByRole("link", { name: "Tracking dots" }).getAttribute("aria-current")).toBe("page"));
    expect(screen.getByRole("heading", { name: "Tracking dots (DEDA)" })).toBeTruthy();
  });
});
