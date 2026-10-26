/** localStorage that never throws (blocked storage reads as empty and writes are dropped). */
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string): void {
    try {
      localStorage.setItem(key, v);
    } catch {}
  },
};

/** Scans started from this tab; their Download deliveries start automatically (also after a reload). */
export const startedHere = {
  key: "scan.startedHere",
  all(): string[] {
    try {
      return JSON.parse(sessionStorage.getItem(this.key) ?? "[]");
    } catch {
      return [];
    }
  },
  add(id: string) {
    try {
      sessionStorage.setItem(this.key, JSON.stringify([...this.all().slice(-20), id]));
    } catch {}
  },
  remove(id: string) {
    try {
      sessionStorage.setItem(this.key, JSON.stringify(this.all().filter((x) => x !== id)));
    } catch {}
  },
};
