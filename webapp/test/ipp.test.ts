import { expect, test } from "bun:test";
import { getJobAttributesRequest, getPrinterAttributesRequest, jobAttributes, parseIpp, printerAttributes, printJobRequest } from "../src/server/ipp";

/** One attribute value as IPP encodes it: value tag, name (empty = additional value), value. */
function attr(tag: number, name: string, value: Uint8Array): number[] {
  const n = new TextEncoder().encode(name);
  return [tag, n.length >> 8, n.length & 255, ...n, value.length >> 8, value.length & 255, ...value];
}
const int = (v: number) => new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
const str = (s: string) => new TextEncoder().encode(s);

const RESPONSE = new Uint8Array([
  0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07,
  0x01,
  ...attr(0x47, "attributes-charset", str("utf-8")),
  0x04,
  ...attr(0x21, "marker-levels", int(80)),
  ...attr(0x21, "", int(30)),
  ...attr(0x21, "", int(-1)),
  ...attr(0x42, "marker-names", str("Cyan Toner")),
  ...attr(0x22, "printer-is-accepting-jobs", new Uint8Array([1])),
  ...attr(0x23, "printer-state", int(3)),
  ...attr(0x44, "printer-state-reasons", str("none")),
  0x03,
]);

test("parseIpp reads status, request id, groups and multi-valued attributes", () => {
  const r = parseIpp(RESPONSE);
  expect(r).toMatchObject({ version: [2, 0], status: 0, requestId: 7 });
  expect(r.groups.map((g) => g.tag)).toEqual([0x01, 0x04]);
  expect(printerAttributes(r)).toEqual({
    "marker-levels": [80, 30, -1],
    "marker-names": ["Cyan Toner"],
    "printer-is-accepting-jobs": [true],
    "printer-state": [3],
    "printer-state-reasons": ["none"],
  });
});

test("parseIpp rejects truncated data", () => {
  expect(() => parseIpp(RESPONSE.subarray(0, RESPONSE.length - 6))).toThrow("IPP");
  expect(() => parseIpp(new Uint8Array([2, 0, 0]))).toThrow("IPP");
});

test("getPrinterAttributesRequest: IPP 2.0 Get-Printer-Attributes with the required operation attributes", () => {
  const req = getPrinterAttributesRequest("ipp://pi:631/printers/P", ["marker-levels", "marker-names"], 9);
  expect([...req.subarray(0, 8)]).toEqual([0x02, 0x00, 0x00, 0x0b, 0x00, 0x00, 0x00, 0x09]);
  const r = parseIpp(req); // same layout: the operation id sits where a response has its status
  expect(r.status).toBe(0x0b);
  expect(r.groups).toHaveLength(1);
  expect(r.groups[0]!.attributes).toEqual({
    "attributes-charset": ["utf-8"],
    "attributes-natural-language": ["en"],
    "printer-uri": ["ipp://pi:631/printers/P"],
    "requested-attributes": ["marker-levels", "marker-names"],
  });
  expect(Object.keys(r.groups[0]!.attributes)[0]).toBe("attributes-charset"); // must come first
});

test("printJobRequest: Print-Job with a raw document after the attributes", () => {
  const req = printJobRequest("ipp://pi:631/printers/P", "supply-refresh", "scan-webapp", new TextEncoder().encode("\n"), 4);
  const r = parseIpp(req);
  expect(r.status).toBe(0x0002);
  expect(r.requestId).toBe(4);
  expect(r.groups[0]!.attributes).toEqual({
    "attributes-charset": ["utf-8"],
    "attributes-natural-language": ["en"],
    "printer-uri": ["ipp://pi:631/printers/P"],
    "requesting-user-name": ["scan-webapp"],
    "job-name": ["supply-refresh"],
    "document-format": ["application/vnd.cups-raw"],
  });
  expect(req.at(-2)).toBe(0x03); // end of attributes, then the data
  expect(req.at(-1)).toBe(0x0a);
});

test("getJobAttributesRequest asks for one job's state; jobAttributes reads the job group", () => {
  const r = parseIpp(getJobAttributesRequest("ipp://pi:631/printers/P", 42, 5));
  expect(r.status).toBe(0x0009);
  expect(r.groups[0]!.attributes).toMatchObject({ "job-id": [42], "requested-attributes": ["job-state"] });
  const resp = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 5, 0x02, 0x23, 0, 9, ...new TextEncoder().encode("job-state"), 0, 4, 0, 0, 0, 9, 0x03]);
  expect(jobAttributes(parseIpp(resp))).toEqual({ "job-state": [9] });
});

test("parseIpp turns a dateTime (RFC 2579) into milliseconds since the epoch, honouring its UTC offset", () => {
  const dt = (bytes: number[]) =>
    parseIpp(new Uint8Array([2, 0, 0, 0, 0, 0, 0, 1, 0x04, 0x31, 0, 20, ...new TextEncoder().encode("printer-current-time"), 0, 11, ...bytes, 0x03]));
  // 2026-10-27 11:29:06.5 UTC
  expect(printerAttributes(dt([0x07, 0xea, 10, 27, 11, 29, 6, 5, 0x2b, 0, 0]))["printer-current-time"]).toEqual([Date.UTC(2026, 9, 27, 11, 29, 6, 500)]);
  // the same moment written as 12:29:06.5 +01:00
  expect(printerAttributes(dt([0x07, 0xea, 10, 27, 12, 29, 6, 5, 0x2b, 1, 0]))["printer-current-time"]).toEqual([Date.UTC(2026, 9, 27, 11, 29, 6, 500)]);
});
