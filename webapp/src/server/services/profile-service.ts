import { getDestination } from "../destinations";
import { DESTINATION_TYPES, LEARNED_FIELDS, SECRET_FIELDS, SECRET_MASK, ValidationError, type DestinationType, type Learned } from "../destinations/types";
import { validateFilter } from "../pipeline/filters";
import {
  validateInput,
  validateOutput,
  type InputProfile,
  type InputProfileDraft,
  type OutputProfile,
  type OutputProfileDraft,
} from "../profiles";
import type { ProfileRepo } from "../repos/profile-repo";
import { NotFound } from "./errors";

/** The config fields that choose where a destination sends to (and so where a stored secret would go). */
const TARGET_FIELDS = ["url", "host", "server"];

/**
 * Which fields must stay unchanged for a masked secret to keep the stored one. "targets" (the web UI): only where the
 * destination sends to, so changing a path or tags keeps the secret. "all" (assistants): every field.
 */
export type GuardScope = "targets" | "all";

/** Input and output profiles: validation, masked-secret rules and the checks before a destination is saved or tested. */
export class ProfileService {
  constructor(private readonly repo: ProfileRepo) {}

  // ---- input profiles

  listInput(): InputProfile[] {
    return this.repo.listInput();
  }

  getInput(id: number): InputProfile {
    const p = this.repo.getInput(id);
    if (!p) throw new NotFound("Input profile not found");
    return p;
  }

  findInput(id: number): InputProfile | null {
    return this.repo.getInput(id);
  }

  /** Ignores a given `id`. */
  createInput(draft: InputProfileDraft): InputProfile {
    return this.repo.saveInput(this.checkInput({ ...draft, id: undefined }));
  }

  updateInput(id: number, draft: InputProfileDraft): InputProfile {
    this.getInput(id);
    return this.repo.saveInput(this.checkInput({ ...draft, id }));
  }

  deleteInput(id: number): void {
    this.repo.deleteInput(id);
  }

  inputExists(id: number): boolean {
    return this.repo.inputExists(id);
  }

  private checkInput(draft: InputProfileDraft): InputProfileDraft {
    validateInput(draft);
    return draft.filter ? { ...draft, filter: validateFilter(draft.filter) } : draft;
  }

  // ---- output profiles

  /** Every profile as the UI and assistants may see it: secrets masked. */
  listOutput(): OutputProfile[] {
    return this.repo.listOutput().map((p) => this.repo.toPublic(p));
  }

  getOutput(id: number): OutputProfile {
    return this.repo.toPublic(this.mustOutput(id));
  }

  /** The stored profile, secrets included: for other services, never for a response. */
  findOutput(id: number): OutputProfile | null {
    return this.repo.getOutput(id);
  }

  /** The profile with every secret decrypted. Throws ValidationError for a missing id, SecretError when a stored secret can't be decrypted. */
  getOutputForUse(id: number): OutputProfile {
    return this.repo.getOutputForUse(id);
  }

  /**
   * Creates (no `id`) or updates (with `id`) an output profile and returns it masked. A masked secret keeps the stored
   * one as far as `scope` allows.
   */
  saveOutput(draft: OutputProfileDraft, scope: GuardScope): OutputProfile {
    const d: OutputProfileDraft = { ...draft };
    delete d.needsCredentials;
    if (d.id !== undefined) this.mustOutput(d.id);
    if (d.destination) {
      const config = (d.destination.config ?? {}) as Record<string, unknown>;
      this.guardMaskedSecrets(d.destination.type, config, d.id, scope);
      d.destination = { ...d.destination, config: this.keepLearned(d.destination.type, config, d.id) };
    }
    this.checkOutput(d, d.id);
    validateOutput(d);
    return this.repo.toPublic(this.repo.saveOutput(d));
  }

  deleteOutput(id: number): void {
    this.repo.deleteOutput(id);
  }

  outputExists(id: number): boolean {
    return this.repo.outputExists(id);
  }

  /** Checks that a saved profile's destination is reachable; what it learned (SFTP's host key) is stored and returned. */
  async testOutput(id: number): Promise<Learned | undefined> {
    const p = this.getOutputForUse(id);
    const d = getDestination(p.destination.type);
    const learned = (await d.test(d.parse(p.destination.config))) ?? undefined;
    if (learned) this.learn(id, p.destination.type, p.destination.config, learned);
    return learned;
  }

  /**
   * Checks a destination configuration before it is saved; `id` is the profile whose stored secrets masked values refer
   * to. Returns what the destination learned, for the form to save; it is also stored when the profile sends to the same place.
   */
  async testDestination(type: string, config: Record<string, unknown>, id: number | undefined, scope: GuardScope): Promise<Learned | undefined> {
    if (!DESTINATION_TYPES.includes(type as DestinationType)) throw new ValidationError(`Unknown destination: ${type}`);
    const t = type as DestinationType;
    const d = getDestination(t);
    this.guardMaskedSecrets(t, config, id, scope);
    const learned = (await d.test(d.parse(this.unmaskConfig(t, this.keepLearned(t, config, id), id)))) ?? undefined;
    if (learned && id !== undefined) this.learn(id, t, config, learned);
    return learned;
  }

  /**
   * Stores fields a destination learned while connecting (SFTP's trusted host key, see destinations/sftp.ts) in the
   * profile it connected for: only while the profile still has that type and target (`used` is the config it
   * connected with), and never over a stored value.
   */
  learn(id: number, type: DestinationType, used: Record<string, unknown>, learned: Learned): void {
    const stored = this.repo.getOutput(id);
    if (!stored || stored.destination.type !== type) return;
    const cfg = stored.destination.config;
    if (!this.sameTarget(cfg, used)) return;
    const fresh = Object.entries(learned).filter(([k]) => !cfg[k]);
    if (!fresh.length) return;
    const pub = this.repo.toPublic(stored); // masked secrets keep the sealed ones
    this.repo.saveOutput({ ...pub, destination: { type, config: { ...pub.destination.config, ...Object.fromEntries(fresh) } } });
  }

  /**
   * Server-managed fields (LEARNED_FIELDS: SFTP's host key) of a config from a form or an assistant: `null` forgets the
   * stored value, a non-empty value replaces it (pins another key), and "" or a missing field keeps the stored one
   * while the profile has the same type and target, so a form opened before a delivery stored the key can't clear it.
   */
  private keepLearned(type: DestinationType, config: Record<string, unknown>, id: number | undefined): Record<string, unknown> {
    const fields = LEARNED_FIELDS[type];
    if (!fields) return config;
    const stored = id !== undefined ? this.repo.getOutput(id) : null;
    const cfg = stored?.destination.type === type ? stored.destination.config : null;
    const sameTarget = !!cfg && this.sameTarget(cfg, config);
    const out = { ...config };
    for (const f of fields) {
      if (out[f] === null) out[f] = "";
      else if ((out[f] === undefined || out[f] === "") && sameTarget && typeof cfg![f] === "string") out[f] = cfg![f];
    }
    return out;
  }

  private sameTarget(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    return [...TARGET_FIELDS, "port"].every((k) => String(a[k] ?? "") === String(b[k] ?? ""));
  }

  /** Adds the common profiles whose names are missing. */
  addCommon(): { input: number; output: number } {
    return this.repo.addCommon();
  }

  private mustOutput(id: number): OutputProfile {
    const p = this.repo.getOutput(id);
    if (!p) throw new NotFound("Output profile not found");
    return p;
  }

  /** Masked secret fields (from the UI or an assistant) become the stored values, so a form can be tested/validated unchanged. */
  private unmaskConfig(type: DestinationType, config: Record<string, unknown>, id?: number): Record<string, unknown> {
    const out = { ...config };
    const masked = SECRET_FIELDS[type].filter((f) => out[f] === SECRET_MASK);
    if (!masked.length) return out;
    const stored = id !== undefined ? this.repo.getOutput(id) : null;
    if (stored?.destination.type === type) {
      const used = this.repo.getOutputForUse(id!); // SecretError → needs_credentials
      for (const f of masked) out[f] = used.destination.config[f];
    } else for (const f of masked) out[f] = "";
    return out;
  }

  /**
   * A masked secret may only stand for the stored one when the destination is otherwise unchanged, so a stored password
   * or token is never sent somewhere else.
   */
  private guardMaskedSecrets(type: DestinationType, config: Record<string, unknown>, id: number | undefined, scope: GuardScope): void {
    const secrets = SECRET_FIELDS[type] ?? []; // an unknown type is rejected by checkOutput
    if (!secrets.some((f) => config[f] === SECRET_MASK)) return;
    const stored = id !== undefined ? this.repo.getOutput(id) : null;
    if (!stored || stored.destination.type !== type) return; // nothing stored to reuse: unmaskConfig blanks it
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const only = scope === "targets" ? TARGET_FIELDS : undefined;
    const keys = new Set(
      [...Object.keys(config), ...Object.keys(stored.destination.config)].filter(
        // Learned fields (a host key) don't choose where a secret goes; forgetting one must not need the secrets again.
        (k) => !secrets.includes(k) && !(LEARNED_FIELDS[type] ?? []).includes(k) && (!only || only.includes(k)),
      ),
    );
    for (const k of keys)
      if (!same(config[k], stored.destination.config[k]))
        throw new ValidationError(`The destination changed (${k}); enter the ${secrets.join(" / ")} again instead of the masked value`);
  }

  /** Checks an output profile draft's destination config (secrets that can't be decrypted yet are fine to keep). */
  private checkOutput(draft: OutputProfileDraft, id?: number): void {
    if (!draft.destination || !DESTINATION_TYPES.includes(draft.destination.type)) throw new ValidationError(`Unknown destination: ${draft.destination?.type}`);
    const cfg = this.unmaskConfig(draft.destination.type, (draft.destination.config ?? {}) as Record<string, unknown>, id);
    for (const f of SECRET_FIELDS[draft.destination.type]) if (cfg[f] === undefined) cfg[f] = "";
    getDestination(draft.destination.type).parse(cfg);
  }
}
