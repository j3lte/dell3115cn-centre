import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import { INITIAL_LIVE } from "../../src/web/helpers/live";
import { THEME_KEY } from "../../src/web/helpers/theme";
import type { Settings, Supply } from "../../src/web/types/api";
import type { SaveSetting } from "../../src/web/types/ui";
import { endpoint, FEEDER, OUTPUTS } from "./fixtures";
import { renderWithQuery, screen, stubClipboard, stubFetch, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix reads `document` when imported: load every component that imports Radix after happy-dom is registered.
let SupplyBar: typeof import("../../src/web/components/printer/SupplyBar").SupplyBar;
let CopyLine: typeof import("../../src/web/components/settings/CopyLine").CopyLine;
let ThemeSetting: typeof import("../../src/web/components/settings/ThemeSetting").ThemeSetting;
let PrinterAlert: typeof import("../../src/web/components/status/PrinterAlert").PrinterAlert;
let ConnectionBar: typeof import("../../src/web/components/status/ConnectionBar").ConnectionBar;
let SecretBanner: typeof import("../../src/web/components/status/SecretBanner").SecretBanner;
let NoticeBar: typeof import("../../src/web/components/status/NoticeBar").NoticeBar;
let WhiteCalibrationCard: typeof import("../../src/web/components/settings/WhiteCalibrationCard").WhiteCalibrationCard;
let CleanupSetting: typeof import("../../src/web/components/settings/CleanupSetting").CleanupSetting;
let PrinterWakeSetting: typeof import("../../src/web/components/settings/PrinterWakeSetting").PrinterWakeSetting;
let PrinterPage: typeof import("../../src/web/pages/PrinterPage").PrinterPage;
let PanelButtonSettings: typeof import("../../src/web/components/settings/PanelButtonSettings").PanelButtonSettings;
let McpSettings: typeof import("../../src/web/components/settings/McpSettings").McpSettings;
beforeAll(async () => {
  ({ SupplyBar } = await import("../../src/web/components/printer/SupplyBar"));
  ({ CopyLine } = await import("../../src/web/components/settings/CopyLine"));
  ({ ThemeSetting } = await import("../../src/web/components/settings/ThemeSetting"));
  ({ PrinterAlert } = await import("../../src/web/components/status/PrinterAlert"));
  ({ ConnectionBar } = await import("../../src/web/components/status/ConnectionBar"));
  ({ SecretBanner } = await import("../../src/web/components/status/SecretBanner"));
  ({ NoticeBar } = await import("../../src/web/components/status/NoticeBar"));
  ({ WhiteCalibrationCard } = await import("../../src/web/components/settings/WhiteCalibrationCard"));
  ({ CleanupSetting } = await import("../../src/web/components/settings/CleanupSetting"));
  ({ PrinterWakeSetting } = await import("../../src/web/components/settings/PrinterWakeSetting"));
  ({ PrinterPage } = await import("../../src/web/pages/PrinterPage"));
  ({ PanelButtonSettings } = await import("../../src/web/components/settings/PanelButtonSettings"));
  ({ McpSettings } = await import("../../src/web/components/settings/McpSettings"));
});

afterEach(() => {
  localStorage.clear();
});

const mockClipboard = () => stubClipboard(mock(async (_: string) => {}));

const settingsOf = (over: Partial<Settings> = {}): Settings => ({
  cleanupDays: null,
  buttonInputProfileId: null,
  buttonOutputProfileIds: {},
  mcpEnabled: true,
  mcpKey: "key-1",
  mcpShelfLifeMinutes: 60,
  whiteBalance: {},
  printerWakeHours: 24,
  secretGenerated: false,
  ...over,
});
const saver = () => mock<SaveSetting>(async () => {});

const supply = (over: Partial<Supply> = {}): Supply => ({ type: "toner", name: "Cyan Toner", color: "cyan", level: 80, low: false, ...over });

describe("SupplyBar", () => {
  test("SupplyBar shows the level and the low state", () => {
    const { rerender } = renderWithQuery(
      <ul>
        <SupplyBar supply={supply()} />
      </ul>,
    );
    expect(screen.getByText("Cyan").className).not.toContain("text-warn");
    expect(screen.getByText("80%").className).toContain("text-muted");
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-label")).toBe("Cyan Toner");
    expect(meter.getAttribute("aria-valuenow")).toBe("80");
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("80%");
    rerender(
      <ul>
        <SupplyBar supply={supply({ name: "Black Toner", color: "black", level: 5, low: true })} />
      </ul>,
    );
    expect(screen.getByText("Black").className).toContain("text-warn");
    expect(screen.getByText("5%").className).toContain("text-warn");
    rerender(
      <ul>
        <SupplyBar supply={supply({ name: "Belt Unit", color: "none", level: null })} />
      </ul>,
    );
    expect(screen.getByText("?")).toBeTruthy();
    expect(screen.getByRole("meter").hasAttribute("aria-valuenow")).toBe(false);
  });
});

describe("CopyLine", () => {
  test("CopyLine copies its text", async () => {
    const writeText = mockClipboard();
    renderWithQuery(<CopyLine label="Key" value="abc-123" />);
    expect(screen.getByText("abc-123")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy Key" }));
    expect(writeText).toHaveBeenCalledWith("abc-123");
    expect(screen.getByRole("button", { name: "Copy Key" }).textContent).toBe("Copied");
  });
});

describe("ThemeSetting", () => {
  test("ThemeSetting stores the choice", async () => {
    renderWithQuery(<ThemeSetting />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
});

describe("PrinterAlert", () => {
  test("PrinterAlert links to the Printer tab with the alert text", () => {
    const { rerender } = renderWithQuery(<PrinterAlert variant="bar" text="Printer: Door open" />);
    const link = screen.getByRole("alert");
    expect(link.getAttribute("href")).toBe("#/printer");
    expect(link.textContent).toBe("Printer: Door open");
    expect(link.className).toContain("border-b");
    rerender(<PrinterAlert variant="panel" text="Printer: Door open" />);
    expect(screen.getByRole("alert").className).toContain("rounded-xl");
  });
});

describe("ConnectionBar", () => {
  test("ConnectionBar offers Connect when the scanner service is unreachable", async () => {
    const onConnect = mock(() => {});
    const down = { ...INITIAL_LIVE, connected: true, status: { ...INITIAL_LIVE.status, service: "unreachable" as const, error: "no route" } };
    const { rerender } = renderWithQuery(<ConnectionBar state={down} onConnect={onConnect} />);
    expect(screen.getByText("no route")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Connecting…" }).hasAttribute("disabled")).toBe(true);
    // still connecting to the socket: nothing to press
    rerender(<ConnectionBar state={INITIAL_LIVE} onConnect={onConnect} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("NoticeBar", () => {
  test("NoticeBar shows the server's notice until it is dismissed", async () => {
    const onDismiss = mock(() => {});
    renderWithQuery(<NoticeBar message="Scan button: no input profile set" onDismiss={onDismiss} />);
    expect(screen.getByRole("alert").textContent).toContain("Scan button: no input profile set");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("SecretBanner", () => {
  test("SecretBanner shows the generated secret only while APP_SECRET is not set, and copies it", async () => {
    const writeText = mockClipboard();
    const { container, rerender } = renderWithQuery(<SecretBanner settings={undefined} />);
    expect(container.innerHTML).toBe("");
    rerender(<SecretBanner settings={settingsOf({ generatedSecret: "s3cr3t" })} />);
    expect(container.innerHTML).toBe("");
    rerender(<SecretBanner settings={settingsOf({ secretGenerated: true, generatedSecret: "s3cr3t" })} />);
    expect(screen.getByRole("alert").textContent).toContain("APP_SECRET is not set");
    expect(screen.getByText("APP_SECRET=s3cr3t")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("APP_SECRET=s3cr3t");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

describe("WhiteCalibrationCard", () => {
  const calibrated = settingsOf({ whiteBalance: { flatbed: { gains: [1.1, 1, 1], white: [240, 241, 242], at: 1_700_000_000_000 } } });

  test("WhiteCalibrationCard calibrates a source and is busy until the scan answers", async () => {
    let answer!: (r: Response) => void;
    const { calls } = stubFetch(() => new Promise<Response>((res) => (answer = res)));
    renderWithQuery(<WhiteCalibrationCard settings={calibrated} />);
    // The matcher folds the no-break space before "%" into a space.
    expect(screen.getByText(/^Calibrated .*: Red \+10 % · paper measured 240 \/ 241 \/ 242$/)).toBeTruthy();
    expect(screen.getByText("Not calibrated")).toBeTruthy();
    // Only the calibrated flatbed can be reset.
    expect(screen.getAllByRole("button", { name: "Reset" }).length).toBe(1);
    await user.click(screen.getAllByRole("button", { name: "Calibrate" })[1]!);
    expect(screen.getByRole("button", { name: "Scanning white…" })).toBeTruthy();
    expect(screen.getAllByRole("button").every((b: HTMLElement) => b.hasAttribute("disabled"))).toBe(true);
    expect(calls.map(endpoint)).toEqual(["POST /api/calibration/white"]);
    expect(await calls[0]!.clone().json()).toEqual({ source: "adf" });
    await act(async () => answer(Response.json(calibrated)));
    expect(screen.queryByRole("button", { name: "Scanning white…" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Calibrate" }).every((b: HTMLElement) => !b.hasAttribute("disabled"))).toBe(true);
  });

  test("WhiteCalibrationCard resets a source and shows a failure", async () => {
    const { calls } = stubFetch((req) => (req.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ error: "no_white", message: "No white sheet found" }, { status: 422 })));
    renderWithQuery(<WhiteCalibrationCard settings={calibrated} />);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["DELETE /api/calibration/white/flatbed"]);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Calibrate" })[0]!);
    expect((await screen.findByRole("alert")).textContent).toBe("No white sheet found");
  });
});

describe("CleanupSetting", () => {
  test("CleanupSetting turns cleanup on with 30 days and off again", async () => {
    const save = saver();
    const { rerender } = renderWithQuery(<CleanupSetting settings={settingsOf()} save={save} />);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await user.click(screen.getByRole("switch", { name: /Delete old scans automatically/ }));
    expect(save).toHaveBeenLastCalledWith({ cleanupDays: 30 }, "Cleanup");
    rerender(<CleanupSetting settings={settingsOf({ cleanupDays: 30 })} save={save} />);
    await user.click(screen.getByRole("switch", { name: /Delete old scans automatically/ }));
    expect(save).toHaveBeenLastCalledWith({ cleanupDays: null }, "Cleanup");
  });

  test("CleanupSetting saves a changed number of days", async () => {
    const save = saver();
    renderWithQuery(<CleanupSetting settings={settingsOf({ cleanupDays: 14 })} save={save} />);
    const days = screen.getByRole("spinbutton", { name: "Delete scans older than (days)" }) as HTMLInputElement;
    expect(days.value).toBe("14");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    await user.clear(days);
    await user.type(days, "7");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ cleanupDays: 7 }, "Cleanup");
  });
});

describe("PrinterWakeSetting", () => {
  test("PrinterWakeSetting turns waking off and on again with 24 hours", async () => {
    const save = saver();
    const { rerender } = renderWithQuery(<PrinterWakeSetting settings={settingsOf()} save={save} />);
    const toggle = () => screen.getByRole("switch", { name: /Wake the printer when the app is opened/ });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await user.click(toggle());
    expect(save).toHaveBeenLastCalledWith({ printerWakeHours: null }, "Printer wake-up");
    rerender(<PrinterWakeSetting settings={settingsOf({ printerWakeHours: null })} save={save} />);
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await user.click(toggle());
    expect(save).toHaveBeenLastCalledWith({ printerWakeHours: 24 }, "Printer wake-up");
  });

  test("PrinterWakeSetting saves a changed number of hours; the field refuses more than 720", async () => {
    const save = saver();
    renderWithQuery(<PrinterWakeSetting settings={settingsOf({ printerWakeHours: 24 })} save={save} />);
    const hours = screen.getByRole("spinbutton", { name: "When the last check is older than (hours)" }) as HTMLInputElement;
    expect(hours.value).toBe("24");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    await user.clear(hours);
    await user.type(hours, "6");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenLastCalledWith({ printerWakeHours: 6 }, "Printer wake-up");
    await user.clear(hours);
    await user.type(hours, "5000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(hours.validity.rangeOverflow).toBe(true);
  });
});

describe("PrinterPage", () => {
  const view = { supplies: [], alerts: [], severity: null, pageCount: 66098, readAt: null, checkedAt: 1 };

  test("PrinterPage says when the printer was last read, or that it hasn't been", () => {
    const readAt = new Date(2026, 9, 27, 11, 24).getTime();
    const { rerender } = renderWithQuery(<PrinterPage printer={{ view: { ...view, readAt }, checking: false, check: async () => {} }} />);
    expect(screen.getByText(/Last read from the printer/).textContent).toContain(new Date(readAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    expect(screen.queryByText(/every 6 hours/)).toBeNull();
    rerender(<PrinterPage printer={{ view, checking: false, check: async () => {} }} />);
    expect(screen.queryByText(/Last read from the printer/)).toBeNull();
  });

  test("PrinterPage's Check now wakes the printer and shows that it is checking", async () => {
    const check = mock(async () => {});
    const { rerender } = renderWithQuery(<PrinterPage printer={{ view, checking: false, check }} />);
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(check).toHaveBeenCalledTimes(1);
    rerender(<PrinterPage printer={{ view, checking: true, check }} />);
    expect(screen.getByRole("button", { name: "Checking…" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("PanelButtonSettings", () => {
  test("PanelButtonSettings saves the input profile and the output per format", async () => {
    const save = saver();
    const profiles = { inputs: [FEEDER], outputs: OUTPUTS, loaded: true };
    renderWithQuery(<PanelButtonSettings settings={settingsOf({ buttonInputProfileId: 1, buttonOutputProfileIds: { pdf: 1 } })} profiles={profiles} save={save} />);
    const options = (name: string) => [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options("Input profile")).toEqual(["Not set (button does nothing)", "Letters"]);
    expect(options("Output for JPEG")).toEqual(["Same as PDF", "To folder", "Paperless"]);
    expect(options("Output for PDF")).toEqual(["Not set", "To folder", "Paperless"]);
    await user.selectOptions(screen.getByRole("combobox", { name: "Input profile" }), "");
    expect(save).toHaveBeenLastCalledWith({ buttonInputProfileId: null }, "Printer button");
    await user.selectOptions(screen.getByRole("combobox", { name: "Output for TIFF" }), "2");
    expect(save).toHaveBeenLastCalledWith({ buttonOutputProfileIds: { tiff: 2 } }, "Printer button");
    await user.selectOptions(screen.getByRole("combobox", { name: "Output for PDF" }), "");
    expect(save).toHaveBeenLastCalledWith({ buttonOutputProfileIds: { pdf: null } }, "Printer button");
  });
});

describe("McpSettings", () => {
  test("McpSettings switches the endpoint and saves the shelf life", async () => {
    const save = saver();
    const { rerender } = renderWithQuery(<McpSettings settings={settingsOf()} save={save} />);
    expect(screen.getByText("http://localhost:3000/mcp/")).toBeTruthy();
    expect(screen.getByText('claude mcp add --transport http scanner http://localhost:3000/mcp/ --header "Authorization: Bearer key-1"')).toBeTruthy();
    const minutes = screen.getByRole("spinbutton", { name: "Keep temporary assistant scans for (minutes)" });
    await user.clear(minutes);
    await user.type(minutes, "120");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenLastCalledWith({ mcpShelfLifeMinutes: 120 }, "Shelf life");
    await user.click(screen.getByRole("switch", { name: /Allow AI assistants/ }));
    expect(save).toHaveBeenLastCalledWith({ mcpEnabled: false }, "MCP");
    rerender(<McpSettings settings={settingsOf({ mcpEnabled: false })} save={save} />);
    expect(screen.queryByText("key-1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate key" })).toBeNull();
  });

  test("McpSettings regenerates the key only after confirming", async () => {
    const { calls } = stubFetch(() => Response.json(settingsOf({ mcpKey: "key-2" })));
    renderWithQuery(<McpSettings settings={settingsOf()} save={saver()} />);
    await user.click(screen.getByRole("button", { name: "Regenerate key" }));
    expect(screen.getByRole("dialog", { name: "Regenerate the MCP key?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(calls).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Regenerate key" }));
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await act(async () => {});
    expect(calls.map(endpoint)).toEqual(["POST /api/settings/mcp-key"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("McpSettings shows why regenerating the key failed", async () => {
    stubFetch(() => Response.json({ error: "internal", message: "Database is locked" }, { status: 500 }));
    renderWithQuery(<McpSettings settings={settingsOf()} save={saver()} />);
    await user.click(screen.getByRole("button", { name: "Regenerate key" }));
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Database is locked");
  });
});
