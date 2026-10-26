/** Hash routes: "#/history/<id>" → ["history", "<id>"]. */
export function hashParts(): string[] {
  return location.hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p));
}

export function go(...parts: (string | number)[]): void {
  location.hash = `#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}
