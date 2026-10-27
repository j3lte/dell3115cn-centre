import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppSettings } from "../db";
import { DESTINATION_TYPES, type DestinationType } from "../destinations/types";
import type { Filter } from "../pipeline/filters";
import type { InputProfileDraft, OutputProfileDraft } from "../profiles";
import { NotFound, StateError } from "../services/errors";
import { jsonResult, run, type McpDeps } from "./common";
import { sanitize } from "./tools-scan";

const object = z.record(z.string(), z.unknown());
const filterPatch = object.describe("Filter fields to change: preset, threshold, brightness, contrast, autoCrop, deskew, sharpen");
const destructive = { destructiveHint: true } as const;
const readOnly = { readOnlyHint: true } as const;

/** What assistants may see of the settings: never the MCP switch, key or shelf life. */
function publicSettings(s: AppSettings) {
  return {
    cleanupDays: s.cleanupDays,
    buttonInputProfileId: s.buttonInputProfileId,
    buttonOutputProfileIds: s.buttonOutputProfileIds,
    printerWakeHours: s.printerWakeHours,
  };
}

/** Review, delivery, history and administration tools. */
export function registerAdminTools(server: McpServer, deps: McpDeps): void {
  const { profiles, scans, settings } = deps.services;

  /** Looks the scan up first, so an expired temporary scan gets the explanatory NotFound. */
  const scan = (id: string) => {
    scans.touch(id);
    return scans.mustGet(id);
  };

  // ---- pages and filters
  server.registerTool(
    "rotate_page",
    { description: "Turn a page clockwise.", inputSchema: { scan_id: z.string(), page: z.number().int().min(1), degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) } },
    (a) => run(async () => (scan(a.scan_id), jsonResult(sanitize(await scans.rotate(a.scan_id, a.page, a.degrees))))),
  );
  server.registerTool(
    "remove_page",
    { description: "Delete a page from a scan.", inputSchema: { scan_id: z.string(), page: z.number().int().min(1) }, annotations: destructive },
    (a) => run(async () => (scan(a.scan_id), jsonResult(sanitize(await scans.removePage(a.scan_id, a.page))))),
  );
  server.registerTool(
    "reorder_pages",
    { description: "Put the pages in a new order: list every current page number once, in the new order.", inputSchema: { scan_id: z.string(), order: z.array(z.number().int()) } },
    (a) => run(async () => (scan(a.scan_id), jsonResult(sanitize(await scans.reorder(a.scan_id, a.order))))),
  );
  server.registerTool(
    "set_scan_filter",
    { description: "Change the filter of the whole scan (pages with their own filter keep theirs).", inputSchema: { scan_id: z.string(), filter: filterPatch } },
    (a) =>
      run(async () => {
        const v = scan(a.scan_id);
        return jsonResult(sanitize(await scans.setScanFilter(a.scan_id, { ...v.filter, ...a.filter } as Filter)));
      }),
  );
  server.registerTool(
    "set_page_filter",
    {
      description: "Give one page its own filter (fields not given come from its current filter), or null to use the scan's filter again.",
      inputSchema: { scan_id: z.string(), page: z.number().int().min(1), filter: filterPatch.nullable() },
    },
    (a) =>
      run(async () => {
        const v = scan(a.scan_id);
        const p = v.pages.find((x) => x.n === a.page);
        if (!p) throw new NotFound(`Page ${a.page} not found`);
        const f = a.filter === null ? null : ({ ...(p.filter ?? v.filter), ...a.filter } as Filter);
        return jsonResult(sanitize(await scans.setPageFilter(a.scan_id, a.page, f)));
      }),
  );

  // ---- delivery
  server.registerTool(
    "send_scan",
    {
      description: "Deliver a scan with an output profile (e.g. to Paperless or a folder). Only when the user asks for delivery. A temporary scan is stored first.",
      inputSchema: { scan_id: z.string(), output_profile_id: z.number().int() },
    },
    (a) =>
      run(async () => {
        const v = scan(a.scan_id);
        if (v.temporary) {
          // Check first, so a scan that can't be sent stays temporary instead of landing in History.
          if (!profiles.outputExists(a.output_profile_id)) throw new NotFound(`Output profile ${a.output_profile_id} not found`);
          if (v.status !== "ready" && v.status !== "review") throw new StateError(`A ${v.status} scan can't be sent`);
          if (!v.pages.length) throw new StateError("There are no pages to send");
          scans.store(a.scan_id);
        }
        return jsonResult(sanitize(await scans.send(a.scan_id, a.output_profile_id)));
      }),
  );
  server.registerTool(
    "resend_scan",
    { description: "Deliver a finished or cancelled scan (with pages) again, to the same or another output profile.", inputSchema: { scan_id: z.string(), output_profile_id: z.number().int() } },
    (a) => run(async () => (scan(a.scan_id), jsonResult(sanitize(await scans.resend(a.scan_id, a.output_profile_id))))),
  );

  // ---- history
  server.registerTool(
    "delete_scan",
    { description: "Delete a scan with its pages and delivered files from the server.", inputSchema: { scan_id: z.string() }, annotations: destructive },
    (a) =>
      run(async () => {
        scan(a.scan_id);
        await scans.remove(a.scan_id);
        return jsonResult({ deleted: a.scan_id });
      }),
  );
  server.registerTool(
    "cleanup_history",
    { description: "Delete every finished scan older than the given number of days.", inputSchema: { older_than_days: z.number().int().min(1) }, annotations: destructive },
    (a) => run(() => jsonResult({ removed: scans.cleanup(a.older_than_days) })),
  );

  // ---- input profiles
  server.registerTool("list_input_profiles", { description: "Input profiles (how to scan).", annotations: readOnly }, () => run(() => jsonResult(profiles.listInput())));
  server.registerTool(
    "get_input_profile",
    { description: "One input profile.", inputSchema: { id: z.number().int() }, annotations: readOnly },
    (a) =>
      run(() => jsonResult(profiles.getInput(a.id))),
  );
  server.registerTool(
    "save_input_profile",
    {
      description:
        "Create (no id) or update (with id) an input profile: name, source (flatbed|adf), mode (lineart|gray|color), dpi, paper (glass for flatbed; a4|letter|legal for adf), autoOrient, threshold, filter, depth (8 or 16; 16 is colour only).",
      inputSchema: { profile: object },
    },
    (a) =>
      run(() => {
        const draft = a.profile as InputProfileDraft;
        return jsonResult(draft.id !== undefined ? profiles.updateInput(draft.id, draft) : profiles.createInput(draft));
      }),
  );
  server.registerTool(
    "delete_input_profile",
    { description: "Delete an input profile.", inputSchema: { id: z.number().int() }, annotations: destructive },
    (a) => run(() => (profiles.deleteInput(a.id), jsonResult({ deleted: a.id }))),
  );

  // ---- output profiles (secrets are write-only)
  server.registerTool(
    "list_output_profiles",
    { description: "Output profiles (file format and destination). Passwords and tokens are masked.", annotations: readOnly },
    () => run(() => jsonResult(profiles.listOutput())),
  );
  server.registerTool(
    "get_output_profile",
    { description: "One output profile. Passwords and tokens are masked.", inputSchema: { id: z.number().int() }, annotations: readOnly },
    (a) =>
      run(() => jsonResult(profiles.getOutput(a.id))),
  );
  server.registerTool(
    "save_output_profile",
    {
      description:
        "Create (no id) or update (with id) an output profile: name, format, jpegQuality, filenameTemplate, destination { type, config }. " +
        "A masked secret value (as returned by get_output_profile) keeps the stored secret.",
      inputSchema: { profile: object },
    },
    (a) =>
      run(() => {
        return jsonResult(profiles.saveOutput(a.profile as OutputProfileDraft, "all"));
      }),
  );
  server.registerTool(
    "delete_output_profile",
    { description: "Delete an output profile.", inputSchema: { id: z.number().int() }, annotations: destructive },
    (a) => run(() => (profiles.deleteOutput(a.id), jsonResult({ deleted: a.id }))),
  );
  server.registerTool(
    "test_output_profile",
    { description: "Check that a saved output profile's destination is reachable.", inputSchema: { id: z.number().int() } },
    (a) =>
      run(async () => {
        return jsonResult({ ok: true, ...(await profiles.testOutput(a.id)) });
      }),
  );
  server.registerTool(
    "test_destination",
    {
      description: "Check a destination configuration before saving it (id: the profile whose stored secrets masked values refer to).",
      inputSchema: { type: z.enum(DESTINATION_TYPES as [DestinationType, ...DestinationType[]]), config: object, id: z.number().int().optional() },
    },
    (a) =>
      run(async () => {
        return jsonResult({ ok: true, ...(await profiles.testDestination(a.type, a.config, a.id, "all")) });
      }),
  );
  server.registerTool(
    "forget_sftp_host",
    {
      description:
        "Forget the SSH host key an SFTP destination trusted on first use for host:port, after the server's key really changed. " +
        "The next connection trusts the key the server shows.",
      inputSchema: { host: z.string().min(1), port: z.number().int().min(1).max(65535).default(22) },
      annotations: destructive,
    },
    (a) => run(() => (deps.services.hostKeys.forget(a.host, a.port), jsonResult({ forgotten: `${a.host}:${a.port}` }))),
  );
  server.registerTool("add_common_profiles", { description: "Add the common input and output profiles that are missing." }, () =>
    run(() => jsonResult(profiles.addCommon())),
  );

  // ---- settings
  server.registerTool(
    "get_settings",
    {
      description:
        "History cleanup (days, null = off), the printer Scan button's profiles, and printerWakeHours: opening the web app wakes the printer to read it when the last read is older than this (null = never).",
      annotations: readOnly,
    },
    () => run(() => jsonResult(publicSettings(settings.read()))),
  );
  server.registerTool(
    "update_settings",
    {
      description:
        "Change settings: cleanupDays (number or null), buttonInputProfileId, buttonOutputProfileIds ({ jpeg, tiff, pdf }: profile id or null), printerWakeHours (1-720 or null).",
      inputSchema: { settings: object },
    },
    (a) => run(() => jsonResult(publicSettings(settings.update(a.settings, { allowMcp: false })))),
  );
}
