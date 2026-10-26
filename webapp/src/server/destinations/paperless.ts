import { asObject, fetchOk, fileBlob, httpUrl, str, ValidationError, type Destination } from "./types";

export type PaperlessConfig = { url: string; token: string; tags?: number[]; correspondent?: number };

function ids(v: unknown, label: string): number[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [v];
  const out = list.map((x) => Number(x));
  if (out.some((n) => !Number.isInteger(n) || n < 0)) throw new ValidationError(`${label} must be numeric ids`);
  return out.length ? out : undefined;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

export const paperless: Destination<PaperlessConfig> = {
  type: "paperless",
  parse(config) {
    const o = asObject(config);
    const c: PaperlessConfig = { url: httpUrl(o, "url", "Paperless URL"), token: str(o, "token", "API token") };
    const tags = ids(o.tags, "Tags");
    if (tags) c.tags = tags;
    const corr = ids(o.correspondent, "Correspondent");
    if (corr) c.correspondent = corr[0];
    return c;
  },
  async test(c) {
    await fetchOk("Paperless", `${c.url}/api/`, { headers: { authorization: `Token ${c.token}`, accept: "application/json" } }, 10000);
  },
  async send(files, c, meta) {
    const refs: string[] = [];
    for (const f of files) {
      const form = new FormData();
      form.append("document", await fileBlob(f));
      form.append("title", files.length === 1 ? meta.title : stem(f.name));
      for (const t of c.tags ?? []) form.append("tags", String(t));
      if (c.correspondent !== undefined) form.append("correspondent", String(c.correspondent));
      const res = await fetchOk(
        "Paperless",
        `${c.url}/api/documents/post_document/`,
        { method: "POST", headers: { authorization: `Token ${c.token}` }, body: form },
        120000,
      );
      refs.push((await res.text()).replace(/"/g, "").trim());
    }
    return { ref: refs.join(", ") };
  },
};
