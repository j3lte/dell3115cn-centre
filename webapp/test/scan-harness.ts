import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { AnalyseClient } from "../src/server/analyse-client";
import { openDb } from "../src/server/db";
import { LiveHub, type LiveMessage } from "../src/server/live";
import type { InputProfileDraft } from "../src/server/profiles";
import type { PrinterSource } from "../src/server/printer";
import { ProfileRepo } from "../src/server/repos/profile-repo";
import { SettingsRepo } from "../src/server/repos/settings-repo";
import { ScannerClient, type ScannerClientOptions } from "../src/server/scanner-client";
import { SecretBox } from "../src/server/secrets";
import { createServices } from "../src/server/services";
import { FakeScannerService } from "./fake-service";
import { tmpdir } from "./helpers";

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export async function makeHarness(opts: { clock?: () => number; client?: ScannerClientOptions; onMcpChange?: () => void; printer?: PrinterSource; analyse?: AnalyseClient } = {}) {
  const fake = new FakeScannerService().start();
  const dataDir = tmpdir();
  const outDir = tmpdir();
  const db = openDb(join(dataDir, "db.sqlite"));
  const box = new SecretBox("test-secret");
  const repo = new ProfileRepo(db, box);
  const client = new ScannerClient(fake.url, { backoffMs: [50, 50], ...opts.client });
  const messages: LiveMessage[] = [];
  const hub = new LiveHub(() => client.reconnectNow());
  hub.attach({ send: (s: string) => messages.push(JSON.parse(s)) });
  const services = createServices({
    db,
    box,
    secret: { secret: "gen-secret", generated: true },
    client,
    hub,
    dataDir,
    printer: opts.printer,
    analyse: opts.analyse,
    onMcpChange: opts.onMcpChange,
    clock: opts.clock,
  });
  const { profiles, settings, scans: svc } = services;
  client.start();
  const deadline = Date.now() + 2000;
  while (client.status.service !== "connected" && Date.now() < deadline) await Bun.sleep(5);

  const input = (over: Partial<InputProfileDraft> = {}) =>
    repo.saveInput({ name: "Feeder gray", source: "adf", mode: "gray", dpi: 150, paper: "a4", autoOrient: false, threshold: 128, ...over });
  const folderOutput = (over: Record<string, unknown> = {}) =>
    repo.saveOutput({
      name: "To folder",
      format: "pdf_multi",
      jpegQuality: 80,
      filenameTemplate: "{date}_{time}_scan",
      destination: { type: "folder", config: { path: outDir } },
      ...over,
    });

  return {
    fake,
    services,
    db,
    repo,
    settingsRepo: new SettingsRepo(db),
    profiles,
    settings,
    client,
    hub,
    svc,
    dataDir,
    outDir,
    messages,
    input,
    folderOutput,
    outFiles: () => readdirSync(outDir).sort(),
    close() {
      client.stop();
      fake.stop();
      db.close();
    },
  };
}

export async function pdfPages(path: string): Promise<number> {
  return (await PDFDocument.load(readFileSync(path))).getPageCount();
}

/** BitsPerComponent of the (single) image on each PDF page. */
export async function pdfImageBits(path: string): Promise<number[]> {
  const doc = await PDFDocument.load(readFileSync(path));
  return doc.getPages().map((p) => {
    const xo = p.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const s = xo.lookup(xo.keys()[0]!) as PDFRawStream;
    return (s.dict.lookup(PDFName.of("BitsPerComponent")) as PDFNumber).asNumber();
  });
}

/** Page widths in points; used to check page order after reorder (pages of different sizes). */
export async function pdfWidths(path: string): Promise<number[]> {
  const doc = await PDFDocument.load(readFileSync(path));
  return doc.getPages().map((p) => Math.round(p.getSize().width));
}
