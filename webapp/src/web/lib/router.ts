/** Hash routes: "#/history/<id>" → ["history", "<id>"]. */
export function hashParts(): string[] {
  return location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
}

const hashOf = (parts: (string | number)[]) => `#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;

export function go(...parts: (string | number)[]): void {
  location.hash = hashOf(parts);
}

/** Like `go`, but replaces the current history entry: for redirects, so Back doesn't land on the page that redirected. */
export function replace(...parts: (string | number)[]): void {
  location.replace(hashOf(parts));
}
