import { expect, test } from "bun:test";
import { printerFrom, printerHttpUrl, PrinterReader, suppliesFrom } from "../src/server/printer";

const ATTRS = {
  "marker-names": ["Cyan Toner", "Magenta Toner", "Yellow Toner", "Black Toner", "Fuser"],
  "marker-colors": ["cyan", "magenta", "yellow", "black", "none"],
  "marker-types": ["toner", "toner", "toner", "toner", "fuser"],
  "marker-levels": [80, 8, 40, -2, 40],
  "marker-low-levels": [10, 10, 10, 10, 10],
};

test("suppliesFrom maps CUPS marker attributes; unknown levels are null; low at or below the low level", () => {
  expect(suppliesFrom(ATTRS)).toEqual([
    { name: "Cyan Toner", color: "cyan", type: "toner", level: 80, low: false },
    { name: "Magenta Toner", color: "magenta", type: "toner", level: 8, low: true },
    { name: "Yellow Toner", color: "yellow", type: "toner", level: 40, low: false },
    { name: "Black Toner", color: "black", type: "toner", level: null, low: false },
    { name: "Fuser", color: "none", type: "fuser", level: 40, low: false },
  ]);
});

test("suppliesFrom without markers or with missing lists", () => {
  expect(suppliesFrom({})).toEqual([]);
  expect(suppliesFrom({ "marker-names": ["Black Toner"], "marker-levels": [5] })).toEqual([
    { name: "Black Toner", color: "none", type: "other", level: 5, low: false },
  ]);
});

test("printerHttpUrl turns ipp and ipps URIs into the HTTP URL to post to", () => {
  expect(printerHttpUrl("ipp://pi/printers/P")).toBe("http://pi:631/printers/P");
  expect(printerHttpUrl("ipp://pi:8631/printers/P")).toBe("http://pi:8631/printers/P");
  expect(printerHttpUrl("ipps://pi/printers/P")).toBe("https://pi:631/printers/P");
  expect(() => printerHttpUrl("http://pi/x")).toThrow("ipp://");
});

/** A CUPS stand-in: answers Get-Printer-Attributes with the given printer attributes. */
function fakeCups(attrs: Record<string, (string | number)[]>, calls: Request[]) {
  return async (url: string, init: RequestInit) => {
    const req = new Request(url, init);
    calls.push(req);
    const body: number[] = [2, 0, 0, 0, 0, 0, 0, 1, 0x04]; // IPP 2.0, successful-ok, request 1, printer group
    for (const [name, values] of Object.entries(attrs)) {
      values.forEach((v, i) => {
        const n = new TextEncoder().encode(i ? "" : name);
        const val = typeof v === "number" ? [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255] : [...new TextEncoder().encode(v)];
        body.push(typeof v === "number" ? 0x21 : 0x42, n.length >> 8, n.length & 255, ...n, val.length >> 8, val.length & 255, ...val);
      });
    }
    body.push(0x03);
    return new Response(new Uint8Array(body), { headers: { "content-type": "application/ipp" } });
  };
}

test("PrinterReader asks CUPS at most once a minute", async () => {
  const calls: Request[] = [];
  let now = 1_000_000;
  const r = new PrinterReader("ipp://pi/printers/P", { fetch: fakeCups(ATTRS, calls), clock: () => now });
  const a = await r.get();
  expect(a.supplies).toHaveLength(5);
  expect(a.checkedAt).toBe(now);
  expect(calls[0]!.url).toBe("http://pi:631/printers/P");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.headers.get("content-type")).toBe("application/ipp");
  now += 50_000;
  await r.get();
  expect(calls).toHaveLength(1);
  now += 15_000;
  await r.get();
  expect(calls).toHaveLength(2);
});

test("PrinterReader reports a failure and retries after a minute", async () => {
  let now = 0;
  let fail = true;
  const calls: Request[] = [];
  const ok = fakeCups(ATTRS, calls);
  const r = new PrinterReader("ipp://pi/printers/P", {
    fetch: async (i, init) => (fail ? Promise.reject(new Error("ECONNREFUSED")) : ok(i, init)),
    clock: () => now,
  });
  const a = await r.get();
  expect(a).toMatchObject({ supplies: [], checkedAt: 0 });
  expect(a.error).toContain("ECONNREFUSED");
  fail = false;
  now += 30_000;
  expect((await r.get()).error).toBeDefined();
  now += 31_000;
  expect((await r.get()).supplies).toHaveLength(5);
});

test("PrinterReader: an IPP error status is a failure", async () => {
  const r = new PrinterReader("ipp://pi/printers/P", {
    fetch: async () => new Response(new Uint8Array([2, 0, 0x04, 0x06, 0, 0, 0, 1, 0x03])), // client-error-not-found
  });
  expect((await r.get()).error).toContain("0x0406");
});

test("PrinterReader without a printer is disabled", async () => {
  expect(await new PrinterReader(null).get()).toEqual({
    supplies: [],
    alerts: [],
    severity: null,
    pageCount: null,
    readAt: null,
    checkedAt: null,
    disabled: true,
  });
});

test("printerFrom: our alerts from printer-alert-description, severity from the reasons, page count from marker-message", () => {
  expect(
    printerFrom({
      ...ATTRS,
      "printer-state-reasons": ["door-open-error", "media-empty-warning"],
      "printer-alert-description": ["Front cover is open (077-300); Tray 1 is out of paper"],
      "marker-message": ["66098 pages printed"],
    }),
  ).toMatchObject({ alerts: ["Front cover is open (077-300)", "Tray 1 is out of paper"], severity: "error", pageCount: 66098 });
  expect(
    printerFrom({ ...ATTRS, "printer-state-reasons": ["media-empty-warning"], "printer-alert-description": ["Tray 1 is out of paper"] }),
  ).toMatchObject({ alerts: ["Tray 1 is out of paper"], severity: "warning", pageCount: null });
});

test("printerFrom shows no alerts unless one of our reasons is set", () => {
  expect(printerFrom({ ...ATTRS, "printer-state-reasons": ["none"], "printer-alert-description": ["stale text"] })).toMatchObject({ alerts: [], severity: null });
  expect(printerFrom({ ...ATTRS, "printer-state-reasons": ["offline-report"], "printer-alert-description": ["x"] }).alerts).toEqual([]);
});

test("PrinterReader asks CUPS for the state reasons, message and marker message too", async () => {
  const calls: Request[] = [];
  const r = new PrinterReader("ipp://pi/printers/P", { fetch: fakeCups(ATTRS, calls) });
  await r.get();
  const body = new TextDecoder().decode(await calls[0]!.arrayBuffer());
  for (const a of ["printer-state-reasons", "printer-alert-description", "marker-message", "marker-change-time", "printer-current-time"])
    expect(body).toContain(a);
});

/** CUPS stand-in for a refresh: Print-Job → job 7, Get-Job-Attributes → processing, then completed; printer attributes. */
function fakeRefreshCups(ops: number[], attrsAfter: Record<string, (string | number)[]>) {
  let polls = 0;
  const enc = (s: string) => [...new TextEncoder().encode(s)];
  const int = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const one = (tag: number, name: string, value: number[]) => [tag, 0, name.length, ...enc(name), 0, value.length, ...value];
  return async (url: string, init: RequestInit) => {
    const op = (new Uint8Array(init.body as Uint8Array)[2]! << 8) | new Uint8Array(init.body as Uint8Array)[3]!;
    ops.push(op);
    let body: number[];
    if (op === 0x0002) body = [2, 0, 0, 0, 0, 0, 0, 1, 0x02, ...one(0x21, "job-id", int(7)), 0x03];
    else if (op === 0x0009) body = [2, 0, 0, 0, 0, 0, 0, 1, 0x02, ...one(0x23, "job-state", int(++polls < 2 ? 5 : 9)), 0x03];
    else {
      body = [2, 0, 0, 0, 0, 0, 0, 1, 0x04];
      for (const [name, values] of Object.entries(attrsAfter))
        values.forEach((v, i) => body.push(...(typeof v === "number" ? one(0x21, i ? "" : name, int(v)) : one(0x42, i ? "" : name, enc(v)))));
      body.push(0x03);
    }
    return new Response(new Uint8Array(body), { headers: { "content-type": "application/ipp" } });
  };
}

test("refresh sends a supply-refresh job, waits for it and reads the fresh state (not the cache)", async () => {
  const ops: number[] = [];
  const r = new PrinterReader("ipp://pi/printers/P", { fetch: fakeRefreshCups(ops, { ...ATTRS, "marker-message": ["66099 pages printed"] }), wait: async () => {} });
  await r.get(); // fills the cache
  const v = await r.refresh();
  expect(ops).toEqual([0x000b, 0x0002, 0x0009, 0x0009, 0x000b]);
  expect(v.pageCount).toBe(66099);
});

test("refresh without a printer is the disabled view", async () => {
  expect((await new PrinterReader(null).refresh()).disabled).toBe(true);
});

test("printerFrom: readAt on this app's clock, from the age on CUPS' own clock (printer-current-time)", () => {
  const cupsNow = Date.UTC(2026, 9, 27, 11, 29, 6); // the print server's clock, 40 min ahead of ours
  const a = { ...ATTRS, "marker-change-time": [cupsNow / 1000 - 3600], "printer-current-time": [cupsNow] };
  const ours = cupsNow - 40 * 60_000;
  expect(printerFrom(a, ours).readAt).toBe(ours - 3_600_000);
  expect(printerFrom(a).readAt).toBe(cupsNow - 3_600_000); // without our clock: CUPS' timestamp as it is
});

test("printerFrom: readAt is when CUPS last got supply data from the backend (marker-change-time, seconds)", () => {
  expect(printerFrom({ ...ATTRS, "marker-change-time": [1793096659] }).readAt).toBe(1793096659_000);
  expect(printerFrom(ATTRS).readAt).toBeNull();
  expect(printerFrom({ ...ATTRS, "marker-change-time": [0] }).readAt).toBeNull(); // never set
});
