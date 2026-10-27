import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "../../src/web/helpers/routes";
import { INITIAL_LIVE } from "../../src/web/helpers/live";
import { noop } from "./fixtures";
import { renderWithQuery, screen, useDom } from "./setup";

useDom();

// Loaded after happy-dom is registered, like the other component tests.
let Brand: typeof import("../../src/web/components/layout/Brand").Brand;
let NavItem: typeof import("../../src/web/components/layout/NavItem").NavItem;
let Sidebar: typeof import("../../src/web/components/layout/Sidebar").Sidebar;
beforeAll(async () => {
  ({ Brand } = await import("../../src/web/components/layout/Brand"));
  ({ NavItem } = await import("../../src/web/components/layout/NavItem"));
  ({ Sidebar } = await import("../../src/web/components/layout/Sidebar"));
});

describe("Brand", () => {
  test('Brand shows the printer icon and "Dell 3115CN"', () => {
    const { container } = renderWithQuery(<Brand />);
    expect(screen.getByText("Dell 3115CN")).toBeTruthy();
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("class")!.split(" ")).toEqual(expect.arrayContaining(["size-6", "fill-none", "stroke-current", "[stroke-width:1.8]"]));
    const top = svg.querySelector("rect")!;
    expect([top.getAttribute("x"), top.getAttribute("y"), top.getAttribute("width"), top.getAttribute("height")]).toEqual(["4", "3.5", "16", "4.5"]);
    expect(svg.querySelector("circle")?.getAttribute("cx")).toBe("15");
  });
});

describe("NavItem", () => {
  test("NavItem marks the current route and shows the alert dot", () => {
    const { rerender } = renderWithQuery(<NavItem route="printer" current kind="side" dot="error" />);
    const link = screen.getByRole("link", { name: /Printer/ });
    expect(link.getAttribute("href")).toBe("#/printer");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("Printer error")).toBeTruthy();

    rerender(<NavItem route="printer" current={false} kind="tab" dot="warning" />);
    expect(screen.getByRole("link", { name: /Printer/ }).hasAttribute("aria-current")).toBe(false);
    expect(screen.getByLabelText("Printer needs attention")).toBeTruthy();

    rerender(<NavItem route="printer" current={false} kind="tab" dot={null} />);
    expect(screen.queryByLabelText(/Printer (error|needs attention)/)).toBeNull();
  });
});

describe("Sidebar", () => {
  test("Sidebar shows the brand, the routes and the printer alert only when there is one", () => {
    const { rerender } = renderWithQuery(<Sidebar state={INITIAL_LIVE} onConnect={noop} route="history" routes={ROUTES} dot={null} printerError={null} />);
    expect(screen.getByText("Dell 3115CN")).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links.map((a: HTMLElement) => a.getAttribute("href"))).toEqual(["#/scan", "#/history", "#/analyse", "#/printer", "#/profiles", "#/settings"]);
    expect(screen.getByRole("link", { name: "History" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("Printer: Paper jam")).toBeNull();

    rerender(<Sidebar state={INITIAL_LIVE} onConnect={noop} route="history" routes={ROUTES} dot="error" printerError="Printer: Paper jam" />);
    expect(screen.getByText("Printer: Paper jam")).toBeTruthy();
  });
});

describe("index.html", () => {
  test("index.html names the printer", () => {
    const html = readFileSync(join(import.meta.dir, "../../src/web/index.html"), "utf8");
    expect(html).toContain("<title>Dell 3115CN</title>");
    const icon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1] ?? "";
    expect(icon.startsWith("data:image/svg+xml,")).toBe(true);
    expect(icon).toContain("rect x='4' y='3.5'");
    expect(icon).toContain("%231f6f78");
  });
});
