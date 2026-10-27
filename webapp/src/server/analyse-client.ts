import { z } from "zod";

/** Client for the analyse service (contract: analyse/README.md). Pages go over as PNG, reports come back as JSON. */

export type DedaReport = {
  found: boolean;
  dots: number;
  gridScore: number;
  dpi: number;
  paperWhite: [number, number, number];
  decode: Record<string, string> | null;
  decodeError: string | null;
  images: { overview: string; closeRaw?: string; closeEnhanced?: string; closeYellow?: string };
};

const ReportSchema = z.object({
  found: z.boolean(),
  dots: z.number(),
  gridScore: z.number(),
  dpi: z.number(),
  paperWhite: z.tuple([z.number(), z.number(), z.number()]),
  decode: z.record(z.string(), z.string()).nullable(),
  decodeError: z.string().nullable(),
  images: z.object({
    overview: z.string(),
    closeRaw: z.string().optional(),
    closeEnhanced: z.string().optional(),
    closeYellow: z.string().optional(),
  }),
});

const INVALID = "Analyse service sent an invalid response";

export class AnalyseUnreachable extends Error {
  constructor(message = "Analyse service unreachable") {
    super(message);
    this.name = "AnalyseUnreachable";
  }
}
export class AnalyseFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyseFailed";
  }
}

export type AnalyseClientOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };

export class AnalyseClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    opts: AnalyseClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  /** Looks for tracking dots on a stored PNG page scanned at `dpi`. */
  async deda(page: Uint8Array<ArrayBuffer>, dpi: number, signal?: AbortSignal): Promise<DedaReport> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/deda/?dpi=${dpi}`, {
        method: "POST",
        headers: { "Content-Type": "image/png", "Accept-Encoding": "gzip" },
        body: page,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new AnalyseFailed(await errorMessage(res));
      const parsed = ReportSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new AnalyseFailed(INVALID);
      return parsed.data;
    } catch (e) {
      if (e instanceof AnalyseFailed) throw e;
      if (timeout.aborted) throw new AnalyseFailed(`timed out after ${Math.round(this.timeoutMs / 1000)} s`);
      if (signal?.aborted) throw new AnalyseFailed("cancelled");
      throw new AnalyseUnreachable();
    }
  }
}

async function errorMessage(res: Response): Promise<string> {
  const fallback = `Analyse service answered ${res.status}`;
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message ? body.message : fallback;
  } catch {
    return fallback;
  }
}
