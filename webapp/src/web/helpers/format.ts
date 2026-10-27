/** Date and time with the weekday, e.g. for History rows. */
export const formatWhen = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Date and time without the weekday. */
export const formatWhenShort = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const mm = (v: number) => String(Math.round(v * 10) / 10);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Full date and time with seconds, in the browser's locale. */
export const formatFull = (ms: number) => new Date(ms).toLocaleString();
