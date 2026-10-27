import type { AppSettings } from "../../server/db";
import type { Filter } from "../../server/pipeline/filters";
import type { InputProfile, InputProfileDraft, OutputProfile, OutputProfileDraft } from "../../server/profiles";
import type { ScannerStatus } from "../../server/scanner-client";
import type { DedaCandidate, DedaView } from "../../server/services/deda-service";
import type { AreaMm, DeliveryView, ScanView } from "../../server/services/scan-service";
import type { PrinterView, Supply } from "../../server/printer";

export type { AppSettings, AreaMm, DedaCandidate, DedaView, DeliveryView, Filter, InputProfile, InputProfileDraft, OutputProfile, OutputProfileDraft, PrinterView, ScannerStatus, ScanView, Supply };
export type Settings = AppSettings & { secretGenerated: boolean; generatedSecret?: string };
