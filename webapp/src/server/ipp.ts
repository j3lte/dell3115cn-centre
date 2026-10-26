/**
 * Just enough IPP (RFC 8010) to ask CUPS for printer attributes: encode a Get-Printer-Attributes request, decode
 * the response. Integers, enums and booleans become numbers/booleans, text-like values strings, anything else bytes.
 */

export type IppValue = number | boolean | string | Uint8Array;
export type IppAttributes = Record<string, IppValue[]>;
export type IppMessage = { version: [number, number]; status: number; requestId: number; groups: { tag: number; attributes: IppAttributes }[] };

const OPERATION_GROUP = 0x01;
const JOB_GROUP = 0x02;
const END = 0x03;
const PRINTER_GROUP = 0x04;
const PRINT_JOB = 0x0002;
const GET_JOB_ATTRIBUTES = 0x0009;
const GET_PRINTER_ATTRIBUTES = 0x000b;
const TAG = {
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
} as const;
/** textWithoutLanguage … mimeMediaType, plus memberAttrName: values that are plain UTF-8 strings. */
const STRING_TAGS = new Set([0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a]);

type Attr = [tag: number, name: string, values: (string | number)[]];

/** An IPP 2.0 request: the operation attributes (charset and language first, as required), then optional data. */
function request(operation: number, requestId: number, attrs: Attr[], data?: Uint8Array): Uint8Array<ArrayBuffer> {
  const out: number[] = [2, 0, operation >> 8, operation & 255, ...u32(requestId), OPERATION_GROUP];
  const all: Attr[] = [[TAG.charset, "attributes-charset", ["utf-8"]], [TAG.naturalLanguage, "attributes-natural-language", ["en"]], ...attrs];
  for (const [tag, name, values] of all)
    values.forEach((v, i) => out.push(tag, ...sized(i ? "" : name), ...(typeof v === "number" ? [0, 4, ...u32(v)] : sized(v))));
  out.push(END);
  if (data) out.push(...data);
  return new Uint8Array(out);
}

export function getPrinterAttributesRequest(printerUri: string, requested: string[], requestId: number): Uint8Array<ArrayBuffer> {
  return request(GET_PRINTER_ATTRIBUTES, requestId, [[TAG.uri, "printer-uri", [printerUri]], ...(requested.length ? [[TAG.keyword, "requested-attributes", requested] as Attr] : [])]);
}

/** Print-Job with a raw document (CUPS sends it to the backend unfiltered). */
export function printJobRequest(printerUri: string, jobName: string, user: string, data: Uint8Array, requestId: number): Uint8Array<ArrayBuffer> {
  return request(
    PRINT_JOB,
    requestId,
    [
      [TAG.uri, "printer-uri", [printerUri]],
      [TAG.name, "requesting-user-name", [user]],
      [TAG.name, "job-name", [jobName]],
      [TAG.mimeMediaType, "document-format", ["application/vnd.cups-raw"]],
    ],
    data,
  );
}

export function getJobAttributesRequest(printerUri: string, jobId: number, requestId: number): Uint8Array<ArrayBuffer> {
  return request(GET_JOB_ATTRIBUTES, requestId, [
    [TAG.uri, "printer-uri", [printerUri]],
    [TAG.integer, "job-id", [jobId]],
    [TAG.keyword, "requested-attributes", ["job-state"]],
  ]);
}

export function parseIpp(data: Uint8Array): IppMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  const need = (n: number) => {
    if (at + n > data.length) throw new Error("Truncated IPP message");
  };
  need(8);
  const msg: IppMessage = { version: [data[0]!, data[1]!], status: view.getUint16(2), requestId: view.getUint32(4), groups: [] };
  at = 8;
  let attrs: IppAttributes | null = null;
  let last: IppValue[] | null = null;
  const text = new TextDecoder();
  for (;;) {
    need(1);
    const tag = data[at++]!;
    if (tag === END) return msg;
    if (tag < 0x10) {
      attrs = {};
      msg.groups.push({ tag, attributes: attrs });
      last = null;
      continue;
    }
    if (!attrs) throw new Error("IPP attribute outside a group");
    need(2);
    const nameLen = view.getUint16(at);
    at += 2;
    need(nameLen + 2);
    const name = text.decode(data.subarray(at, at + nameLen));
    at += nameLen;
    const len = view.getUint16(at);
    at += 2;
    need(len);
    const raw = data.subarray(at, at + len);
    at += len;
    const value: IppValue =
      (tag === TAG.integer || tag === TAG.enum) && len === 4 ? view.getInt32(at - 4)
      : tag === TAG.boolean && len === 1 ? raw[0] !== 0
      : STRING_TAGS.has(tag) ? text.decode(raw)
      : raw.slice();
    if (name) attrs[name] = last = [value];
    else if (last) last.push(value);
  }
}

/** All printer-group attributes of a response. */
export function printerAttributes(msg: IppMessage): IppAttributes {
  return Object.assign({}, ...msg.groups.filter((g) => g.tag === PRINTER_GROUP).map((g) => g.attributes));
}

/** All job-group attributes of a response. */
export function jobAttributes(msg: IppMessage): IppAttributes {
  return Object.assign({}, ...msg.groups.filter((g) => g.tag === JOB_GROUP).map((g) => g.attributes));
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function sized(s: string): number[] {
  const b = new TextEncoder().encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}
