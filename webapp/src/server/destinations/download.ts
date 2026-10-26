import { asObject, type Destination } from "./types";

/** Files stay in history and are downloaded by the browser; nothing to send. */
export const download: Destination<Record<string, never>> = {
  type: "download",
  parse(config) {
    asObject(config ?? {});
    return {};
  },
  async test() {},
  async send() {
    return {};
  },
};
