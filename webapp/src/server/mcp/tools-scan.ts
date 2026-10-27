import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { z } from "zod";
import { logger } from "../log";
import { DEFAULT_FILTER, type Filter } from "../pipeline/filters";
import { GLASS_MM, LLM_MAX_PX } from "../pipeline/region";
import { DPIS, FORMATS, ValidationError, type InputProfile } from "../profiles";
import type { PrinterView } from "../printer";
import { NotFound } from "../services/errors";
import { adhocProfile, type AreaMm, type ScanView } from "../services/scan-service";
import { jsonResult, run, type McpContext, type McpDeps } from "./common";

const log = logger("mcp");

const rect = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[x, y, width, height] in mm");
const filterSchema = z
  .object({
    preset: z.enum(["none", "document", "gray", "bw"]).optional(),
    threshold: z.number().int().min(0).max(255).optional().describe("black & white threshold"),
    brightness: z.number().int().min(-100).max(100).optional(),
    contrast: z.number().int().min(-100).max(100).optional(),
    autoCrop: z.boolean().optional(),
    deskew: z.boolean().optional().describe("straighten"),
    sharpen: z.enum(["off", "light", "normal"]).optional().describe("undo the scanner's blur (best at 300-600 dpi)"),
  })
  .describe("Filter; missing fields keep their defaults");
/** Below the 60 s request timeout most MCP clients use; a longer scan returns its id with a hint to call get_scan. */
export const DEFAULT_WAIT_SECONDS = 45;
const waitSeconds = z
  .number()
  .min(0)
  .max(600)
  .optional()
  .describe(`How long to wait for the scan to finish (default ${DEFAULT_WAIT_SECONDS}); raise it only if your client allows longer calls`);

/** A scan as an assistant sees it: no /api URLs (the assistant uses download links), expiry as ISO time. */
export function sanitize(v: ScanView): Record<string, unknown> {
  const { pages, deliveries, expiresAt, ...rest } = v;
  return {
    ...rest,
    ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    pages: pages.map(({ thumbUrl: _t, viewUrl: _v, ...p }) => p),
    deliveries: deliveries.map((d) => ({ ...d, files: d.files.map((f) => ({ name: f.name })) })),
  };
}

const image = (jpeg: Buffer) => ({ type: "image" as const, data: jpeg.toString("base64"), mimeType: "image/jpeg" });

/** Scanner, scanning, viewing and download tools. */
export function registerScanTools(server: McpServer, deps: McpDeps, ctx: McpContext): void {
  const { scanner, scans, profiles } = deps.services;
  const { downloads } = deps;

  /** The scan after waiting up to `seconds` for its background work; with page 1 as an image when finished. */
  async function finished(id: string, seconds = DEFAULT_WAIT_SECONDS): Promise<CallToolResult> {
    const done = await Promise.race([scans.settled(id).then(() => true), Bun.sleep(seconds * 1000).then(() => false)]);
    const v = scans.mustGet(id);
    if (!done || v.status === "scanning")
      return jsonResult({ ...sanitize(v), note: "Still scanning; call get_scan with this scan id to see the result" });
    const result = jsonResult(sanitize(v));
    if (v.status === "failed" && !v.pages.length) return { ...result, isError: true }; // e.g. empty feeder, jam, lost scanner
    if (v.pages.length) result.content.push(image((await scans.pageImage(id, v.pages[0]!.n)).jpeg));
    return result;
  }

  /** The scanner's state and the printer's report: as last read, or (refresh_scanner_status) read again first. */
  const status = async (printer: PrinterView) => {
    const printerReport = {
      alerts: printer.alerts,
      severity: printer.severity,
      pageCount: printer.pageCount,
      supplies: printer.supplies,
      readAt: printer.readAt === null ? null : new Date(printer.readAt).toISOString(),
      ...(printer.error ? { error: printer.error } : {}),
    };
    return jsonResult({ ...scanner.status, printerReport });
  };

  server.registerTool(
    "scanner_status",
    {
      description:
        "State of the scanner: whether the scanner service is connected, the printer's state and whether paper is in the document feeder; and `printerReport`: alerts the printer reported when it was last read (covers, trays, error codes like 077-300, low supplies; severity error = printing blocked), the toner, belt unit and fuser levels (percent; null = unknown), the lifetime page count and `readAt`, when the printer was last read (after its last print job or wake-up). A sleeping printer doesn't notice changes; refresh_scanner_status wakes it for a fresh report.",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => status(await deps.services.printer.get())),
  );

  server.registerTool(
    "refresh_scanner_status",
    {
      description:
        "The same as scanner_status, but wakes the printer first and reads it again, so `printerReport` is current (an opened cover, refilled paper). Waking makes warm-up noise and takes up to a minute; nothing is printed. Use it when the user asks for the printer's current state, not for routine checks.",
    },
    () => run(async () => status(await deps.services.printer.refresh())),
  );

  server.registerTool(
    "scanner_connect",
    { description: "Reconnect to the scanner service now (after it was unreachable)." },
    () =>
      run(async () => {
        scanner.reconnectNow();
        await Bun.sleep(500);
        return jsonResult({ ...scanner.status });
      }),
  );

  server.registerTool(
    "preview",
    {
      description: "Quick 75 dpi colour scan of the whole flatbed glass, to see what is on it and choose an area (mm from the top-left corner).",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const png = await scans.preview();
        const jpeg = await sharp(png).resize(LLM_MAX_PX, LLM_MAX_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        const m = await sharp(jpeg).metadata();
        const result = jsonResult({ glassMm: GLASS_MM, width: m.width, height: m.height, pxPerMm: m.width! / GLASS_MM[0] });
        result.content.push(image(jpeg));
        return result;
      }),
  );

  server.registerTool(
    "scan",
    {
      description:
        "Scan with your own settings (no profile needed). Waits until the scan has finished and returns it with page 1 as an image. " +
        "The scan is temporary unless store is true. Nothing is sent anywhere.",
      inputSchema: {
        source: z.enum(["flatbed", "adf"]).optional().describe('"adf" = the document feeder (required without input_profile_id)'),
        mode: z.enum(["lineart", "gray", "color"]).optional().describe('"lineart" = black & white (required without input_profile_id)'),
        dpi: z
          .number()
          .int()
          .refine((d) => (DPIS as number[]).includes(d), `one of ${DPIS.join(", ")}`)
          .optional()
          .describe("required without input_profile_id"),
        depth: z.union([z.literal(8), z.literal(16)]).optional().describe("bits per channel; 16 is colour only"),
        paper: z.enum(["a4", "letter", "legal"]).optional().describe("feeder paper size (default A4)"),
        auto_orient: z.boolean().optional().describe("turn pages upright using OCR"),
        threshold: z.number().int().min(0).max(255).optional().describe("lineart threshold"),
        filter: filterSchema.optional(),
        input_profile_id: z.number().int().optional().describe("start from this input profile; the other fields override it"),
        area_mm: rect.optional().describe("flatbed region in glass coordinates (mm from the top-left corner)"),
        page_area: z
          .object({ scan_id: z.string(), page: z.number().int().min(1), rect_mm: rect })
          .optional()
          .describe("flatbed region given on a page of an earlier flatbed scan (mm on that page)"),
        store: z.boolean().optional().describe("keep the scan in History instead of letting it expire"),
        wait_seconds: waitSeconds,
      },
    },
    (a) =>
      run(async () => {
        let base: InputProfile | undefined;
        if (a.input_profile_id !== undefined) {
          base = profiles.findInput(a.input_profile_id) ?? undefined;
          if (!base) throw new NotFound(`Input profile ${a.input_profile_id} not found`);
        }
        if (!base && (a.source === undefined || a.mode === undefined || a.dpi === undefined))
          throw new ValidationError("source, mode and dpi are required (or give input_profile_id)");
        const filter: Filter | undefined = a.filter ? { ...(base?.filter ?? DEFAULT_FILTER), ...a.filter } : undefined;
        const input = adhocProfile(
          { source: a.source, mode: a.mode, dpi: a.dpi as InputProfile["dpi"] | undefined, paper: a.paper, autoOrient: a.auto_orient, threshold: a.threshold, filter, depth: a.depth },
          base,
        );
        let area: AreaMm | undefined = a.area_mm;
        if (a.page_area) area = scans.glassArea(a.page_area.scan_id, a.page_area.page, a.page_area.rect_mm);
        const v = await scans.startAdhoc(input, { areaMm: area, store: a.store === true });
        return finished(v.id, a.wait_seconds);
      }),
  );

  server.registerTool(
    "scan_more",
    {
      description: "Scan more pages into an existing scan (same settings), e.g. the next flatbed page or another feeder stack.",
      inputSchema: { scan_id: z.string(), wait_seconds: waitSeconds },
    },
    (a) =>
      run(async () => {
        scans.touch(a.scan_id);
        scans.mustGet(a.scan_id);
        await scans.more(a.scan_id);
        return finished(a.scan_id, a.wait_seconds);
      }),
  );

  server.registerTool(
    "cancel_scan",
    { description: "Stop a running scan, or discard a scan that has not been sent.", inputSchema: { scan_id: z.string() } },
    (a) =>
      run(async () => {
        scans.touch(a.scan_id);
        scans.mustGet(a.scan_id);
        return jsonResult(sanitize(await scans.cancel(a.scan_id)));
      }),
  );

  server.registerTool(
    "get_scan",
    { description: "A scan with its pages and deliveries (temporary or stored).", inputSchema: { scan_id: z.string() }, annotations: { readOnlyHint: true } },
    (a) =>
      run(() => {
        scans.touch(a.scan_id);
        return jsonResult(sanitize(scans.mustGet(a.scan_id)));
      }),
  );

  server.registerTool(
    "list_scans",
    {
      description: "Scans in History (stored scans), newest first. Use `before` (a createdAt value) to page back.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional(), before: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => run(() => jsonResult(scans.list(a.limit ?? 20, a.before).map(sanitize))),
  );

  server.registerTool(
    "page_image",
    {
      description: "One page as an image (with the scan's filter), at most 1568 px on the long side, plus its size in mm.",
      inputSchema: { scan_id: z.string(), page: z.number().int().min(1), max_px: z.number().int().min(64).max(LLM_MAX_PX).optional() },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run(async () => {
        const img = await scans.pageImage(a.scan_id, a.page, a.max_px);
        const result = jsonResult({ width: img.width, height: img.height, widthMm: img.widthMm, heightMm: img.heightMm });
        result.content.push(image(img.jpeg));
        return result;
      }),
  );

  server.registerTool(
    "zoom",
    {
      description: "A region of a page (mm from the page's top-left corner) at full scan resolution, at most 1568 px on the long side.",
      inputSchema: { scan_id: z.string(), page: z.number().int().min(1), rect_mm: rect, max_px: z.number().int().min(64).max(LLM_MAX_PX).optional() },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      run(async () => {
        const z2 = await scans.zoom(a.scan_id, a.page, a.rect_mm, a.max_px);
        const result = jsonResult({ width: z2.width, height: z2.height, pxPerMm: z2.pxPerMm });
        result.content.push(image(z2.jpeg));
        return result;
      }),
  );

  server.registerTool(
    "store_scan",
    { description: "Keep a temporary scan: it appears in History and no longer expires.", inputSchema: { scan_id: z.string() } },
    (a) =>
      run(() => {
        scans.touch(a.scan_id);
        return jsonResult(sanitize(scans.store(a.scan_id)));
      }),
  );

  server.registerTool(
    "get_download_links",
    {
      description:
        "Download links for a scan, one per file: as a format (pdf_multi = one PDF, pdf_single = one PDF per page, png/jpeg images, " +
        "tiff_multi / tiff_single), one page as PNG, or a file of an earlier delivery. Each link works once and expires after 15 minutes; " +
        "fetch it with a plain GET (no headers needed).",
      inputSchema: {
        scan_id: z.string(),
        format: z.enum(FORMATS as [string, ...string[]]).optional(),
        page: z.number().int().min(1).optional(),
        delivery_id: z.number().int().optional(),
        name: z.string().optional().describe("file name within the delivery"),
      },
    },
    (a) =>
      run(async () => {
        const what =
          a.delivery_id !== undefined
            ? { deliveryId: a.delivery_id, name: a.name ?? "" }
            : a.page !== undefined
              ? { page: a.page }
              : { format: (a.format ?? "pdf_multi") as (typeof FORMATS)[number] };
        const files = await scans.exportFiles(a.scan_id, what, join(deps.dataDir, "exports", crypto.randomUUID()));
        const kind = "format" in what ? what.format : "page" in what ? `page ${what.page}` : `delivery ${what.deliveryId}`;
        log.info(`download link for scan ${a.scan_id}: ${files.length} file(s), ${kind}`);
        return jsonResult({
          scanId: a.scan_id,
          format: "format" in what ? what.format : "page" in what ? "page_png" : "delivery_file",
          files: files.map((f) => {
            const { id, key, size } = downloads.add(f);
            return { name: f.name, mime: f.mime, size, url: `${ctx.baseUrl}/files/${id}?key=${encodeURIComponent(key)}` };
          }),
        });
      }),
  );
}
