import { z } from "@hono/zod-openapi";
import type { Filter } from "../pipeline/filters";
import type { PrinterView, Supply } from "../printer";
import type { WhiteCalibration } from "../pipeline/white";
import type { InputProfile, InputProfileDraft, OutputProfile, OutputProfileDraft } from "../profiles";
import type { ScannerStatus } from "../scanner-client";
import type { DeliveryView, PageView, ScanView } from "../services/scan-service";
import type { SettingsView } from "../services/settings-service";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `exact<T>()(schema)` returns the schema unchanged, but fails typecheck unless `z.infer<typeof schema>` and `T` are
 * assignable to each other, so a response schema cannot drift from the domain type it describes.
 */
export const exact =
  <T>() =>
  <S extends z.ZodType>(schema: S & (Same<z.infer<S>, T> extends true ? unknown : { "schema does not match its type": T })): S =>
    schema;

export const ErrorSchema = exact<{ error: string; message: string }>()(
  z.object({ error: z.string().openapi({ example: "invalid" }), message: z.string() }).openapi("Error"),
);

export const ScannerStatusSchema = exact<ScannerStatus>()(
  z
    .object({
      service: z.enum(["connecting", "connected", "unreachable"]),
      printer: z.enum(["off", "idle", "scanning", "jammed"]).nullable(),
      paperInFeeder: z.boolean(),
      error: z.string().optional(),
    })
    .openapi("ScannerStatus"),
);

const SupplySchema = exact<Supply>()(
  z.object({ name: z.string(), color: z.string(), type: z.string(), level: z.number().nullable(), low: z.boolean() }).openapi("Supply"),
);

export const PrinterViewSchema = exact<PrinterView>()(
  z
    .object({
      supplies: z.array(SupplySchema),
      alerts: z.array(z.string()),
      severity: z.enum(["error", "warning"]).nullable(),
      pageCount: z.number().nullable(),
      readAt: z.number().nullable().openapi({ description: "When the printer was last read (ms since epoch): after a print job or a refresh" }),
      checkedAt: z.number().nullable().openapi({ description: "When this app last asked CUPS (ms since epoch)" }),
      error: z.string().optional(),
      disabled: z.literal(true).optional(),
    })
    .openapi("PrinterView"),
);

/** A path `:id`: digits only, as an integer. Anything else (`abc`, `1.5`, `-1`) is a 400 `invalid`. */
export const IdParam = z
  .string()
  .regex(/^\d+$/, "must be a whole number")
  .transform(Number)
  .pipe(z.int())
  .openapi({ param: { name: "id", in: "path" }, example: "1" });

/**
 * An integer in a request body. A string of digits (optional leading minus) is accepted as that number, as the
 * hand-written router did; the OpenAPI description says integer.
 */
export const IntField = z
  .union([z.int(), z.string().regex(/^-?\d+$/, "must be a whole number").transform(Number).pipe(z.int())])
  .meta({ type: "integer", example: 1 });

// Profile schemas check shape and types only; the value rules (ranges, names, which paper suits which source) stay
// in the ProfileService, whose messages are part of the API.

export const FilterSchema = exact<Filter>()(
  z
    .object({
      preset: z.enum(["none", "document", "gray", "bw"]),
      threshold: z.number(),
      brightness: z.number(),
      contrast: z.number(),
      autoCrop: z.boolean(),
      deskew: z.boolean(),
      sharpen: z.enum(["off", "light", "normal"]).optional(),
    })
    .openapi("Filter"),
);

const inputFields = {
  name: z.string(),
  source: z.enum(["flatbed", "adf"]),
  mode: z.enum(["lineart", "gray", "color"]),
  dpi: z.literal([75, 100, 150, 200, 300, 400, 600]),
  paper: z.enum(["a4", "letter", "legal", "glass"]),
  autoOrient: z.boolean(),
  threshold: z.number(),
  depth: z.literal([8, 16]).optional(),
};

export const InputProfileSchema = exact<InputProfile>()(
  z.object({ id: z.number(), ...inputFields, filter: FilterSchema }).openapi("InputProfile"),
);

export const InputProfileDraftSchema = exact<InputProfileDraft>()(
  z.object({ id: z.number().optional(), ...inputFields, filter: FilterSchema.optional() }).openapi("InputProfileDraft"),
);

const destinationFields = {
  type: z.enum(["download", "folder", "smb", "ftp", "paperless", "papra", "webhook"]),
  config: z.record(z.string(), z.unknown()),
};

const outputFields = {
  name: z.string(),
  format: z.enum(["pdf_single", "pdf_multi", "png", "jpeg", "tiff_single", "tiff_multi"]),
  jpegQuality: z.number(),
  filenameTemplate: z.string(),
  destination: z.object(destinationFields),
};

export const OutputProfileSchema = exact<OutputProfile>()(
  z.object({ id: z.number(), ...outputFields, needsCredentials: z.boolean().optional() }).openapi("OutputProfile"),
);

export const OutputProfileDraftSchema = exact<OutputProfileDraft>()(
  z.object({ id: z.number().optional(), ...outputFields, needsCredentials: z.boolean().optional() }).openapi("OutputProfileDraft"),
);

export const DestinationTestSchema = exact<{ type: string; config?: Record<string, unknown>; id?: number | null }>()(
  z
    .object({ type: z.string(), config: z.record(z.string(), z.unknown()).optional(), id: IntField.nullable().optional().meta({ type: ["integer", "null"] }) })
    .openapi("DestinationTest"),
);

export const PageViewSchema = exact<PageView>()(
  z
    .object({
      n: z.number(),
      width: z.number(),
      height: z.number(),
      rotation: z.number(),
      thumbUrl: z.string(),
      viewUrl: z.string(),
      filter: FilterSchema.nullable(),
    })
    .openapi("PageView"),
);

export const DeliveryViewSchema = exact<DeliveryView>()(
  z
    .object({
      id: z.number(),
      outputProfileId: z.number().nullable(),
      outputProfileName: z.string(),
      status: z.enum(["sending", "sent", "failed"]),
      error: z.string().optional(),
      files: z.array(z.object({ name: z.string(), url: z.string() })),
      createdAt: z.number(),
    })
    .openapi("DeliveryView"),
);

export const ScanViewSchema = exact<ScanView>()(
  z
    .object({
      id: z.string(),
      createdAt: z.number(),
      status: z.enum(["scanning", "review", "ready", "delivering", "done", "failed", "cancelled"]),
      review: z.boolean(),
      inputProfile: InputProfileSchema,
      outputProfileId: z.number().nullable(),
      outputProfileName: z.string().optional(),
      origin: z.enum(["ui", "button", "mcp"]),
      temporary: z.boolean(),
      expiresAt: z.number().optional(),
      area: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
      filter: FilterSchema,
      pages: z.array(PageViewSchema),
      problem: z.string().optional(),
      error: z.string().optional(),
      deliveries: z.array(DeliveryViewSchema),
    })
    .openapi("ScanView"),
);

const RgbSchema = z.tuple([z.number(), z.number(), z.number()]);

export const WhiteCalibrationSchema = exact<WhiteCalibration>()(
  z.object({ gains: RgbSchema, white: RgbSchema, at: z.number() }).openapi("WhiteCalibration"),
);

/** `generatedSecret` is only there while the app secret is the generated one; it is the owner's own settings page. */
export const SettingsViewSchema = exact<SettingsView>()(
  z
    .object({
      cleanupDays: z.number().nullable(),
      buttonInputProfileId: z.number().nullable(),
      buttonOutputProfileIds: z.partialRecord(z.enum(["jpeg", "tiff", "pdf"]), z.number()),
      mcpEnabled: z.boolean(),
      mcpKey: z.string().nullable(),
      mcpShelfLifeMinutes: z.number(),
      whiteBalance: z.partialRecord(z.enum(["flatbed", "adf"]), WhiteCalibrationSchema),
      printerWakeHours: z.number().nullable(),
      secretGenerated: z.boolean(),
      generatedSecret: z.string().optional(),
    })
    .openapi("SettingsView"),
);
