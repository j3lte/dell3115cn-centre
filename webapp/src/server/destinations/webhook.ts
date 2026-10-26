import { asObject, fetchOk, fileBlob, httpUrl, str, ValidationError, type Destination } from "./types";

export type WebhookConfig = { url: string; headerName?: string; headerValue?: string };

export const webhook: Destination<WebhookConfig> = {
  type: "webhook",
  parse(config) {
    const o = asObject(config);
    const c: WebhookConfig = { url: httpUrl(o, "url", "Webhook URL") };
    const name = str(o, "headerName", "Header name", false);
    if (name) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new ValidationError("Header name contains invalid characters");
      c.headerName = name;
      c.headerValue = str(o, "headerValue", "Header value", false);
    }
    return c;
  },
  async test(c) {
    const form = new FormData();
    form.append("meta", JSON.stringify({ test: true }));
    await fetchOk("Webhook", c.url, { method: "POST", headers: headers(c), body: form }, 10000);
  },
  async send(files, c, meta) {
    const form = new FormData();
    for (const f of files) form.append("file", await fileBlob(f));
    form.append("meta", JSON.stringify({ scanId: meta.scanId, title: meta.title, files: files.map((f) => f.name) }));
    await fetchOk("Webhook", c.url, { method: "POST", headers: headers(c), body: form }, 120000);
    return {};
  },
};

function headers(c: WebhookConfig): Record<string, string> {
  return c.headerName ? { [c.headerName]: c.headerValue ?? "" } : {};
}
