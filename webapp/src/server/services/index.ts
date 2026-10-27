import type { Database } from "bun:sqlite";
import type { AnalyseClient } from "../analyse-client";
import type { LiveHub } from "../live";
import type { PrinterSource } from "../printer";
import { createDestinations } from "../destinations";
import type { HostKeyStore } from "../destinations/sftp";
import { DedaRepo } from "../repos/deda-repo";
import { HostKeyRepo } from "../repos/host-key-repo";
import { ProfileRepo } from "../repos/profile-repo";
import { ScanRepo } from "../repos/scan-repo";
import { SettingsRepo } from "../repos/settings-repo";
import type { ScannerClient } from "../scanner-client";
import type { SecretBox } from "../secrets";
import { CalibrationService } from "./calibration-service";
import { DedaService } from "./deda-service";
import { PrinterService } from "./printer-service";
import { ProfileService } from "./profile-service";
import { ScanService } from "./scan-service";
import { SettingsService } from "./settings-service";

export type Services = {
  settings: SettingsService;
  profiles: ProfileService;
  /** SFTP host keys trusted on first use. */
  hostKeys: HostKeyStore;
  scans: ScanService;
  calibration: CalibrationService;
  printer: PrinterService;
  scanner: ScannerClient;
  hub: LiveHub;
  analyse: AnalyseClient | null;
  /** Tracking-dot analyses; only with an analyse service (ANALYSE_ENDPOINT). */
  deda: DedaService | null;
};

export type ServicesDeps = {
  db: Database;
  box: SecretBox;
  secret: { secret: string; generated: boolean };
  client: ScannerClient;
  hub: LiveHub;
  dataDir: string;
  printer?: PrinterSource;
  analyse?: AnalyseClient;
  onMcpChange?: () => void;
  clock?: () => number;
};

/** The composition root: one database and one scanner client behind every service. */
export function createServices(deps: ServicesDeps): Services {
  const { db, client, hub, dataDir, clock } = deps;
  const hostKeys = new HostKeyRepo(db, clock);
  const profiles = new ProfileService(new ProfileRepo(db, deps.box), createDestinations({ hostKeys }));
  const settings = new SettingsService(new SettingsRepo(db), profiles, deps.secret, deps.onMcpChange);
  const calibration = new CalibrationService(settings, client, clock);
  const scans = new ScanService({ repo: new ScanRepo(db), profiles, settings, calibration, client, hub, dataDir }, { clock });
  const analyse = deps.analyse ?? null;
  const deda = analyse ? new DedaService({ repo: new DedaRepo(db), scans, analyse, dataDir, clock }) : null;
  const printer = new PrinterService(deps.printer, () => settings.read().printerWakeHours, clock);
  return { settings, profiles, hostKeys, scans, calibration, printer, scanner: client, hub, analyse, deda };
}
