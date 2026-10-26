import { asObject, DeliveryError, fetchOk, fileBlob, httpUrl, str, type Destination } from "./types";

export type PapraConfig = { url: string; apiKey: string; organizationId: string };

export const papra: Destination<PapraConfig> = {
  type: "papra",
  parse(config) {
    const o = asObject(config);
    return { url: httpUrl(o, "url", "Papra URL"), apiKey: str(o, "apiKey", "API key"), organizationId: str(o, "organizationId", "Organisation id") };
  },
  async test(c) {
    const res = await fetchOk("Papra", `${c.url}/api/organizations`, { headers: { authorization: `Bearer ${c.apiKey}`, accept: "application/json" } }, 10000);
    const body = (await res.json().catch(() => null)) as { organizations?: { id?: string }[] } | { id?: string }[] | null;
    const orgs = Array.isArray(body) ? body : (body?.organizations ?? []);
    if (!orgs.some((org) => org?.id === c.organizationId)) throw new DeliveryError(`Papra: organisation ${c.organizationId} not found for this API key`);
  },
  async send(files, c) {
    const refs: string[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append("file", await fileBlob(f));
      const res = await fetchOk(
        "Papra",
        `${c.url}/api/organizations/${encodeURIComponent(c.organizationId)}/documents`,
        { method: "POST", headers: { authorization: `Bearer ${c.apiKey}` }, body: form },
        120000,
      );
      const body = (await res.json().catch(() => null)) as { document?: { id?: string } } | null;
      if (body?.document?.id) refs.push(body.document.id);
    }
    return refs.length ? { ref: refs.join(", ") } : {};
  },
};
