import { beforeEach, expect, test } from "bun:test";
import { openLiveSocket } from "../../src/web/lib/live-socket";
import { FakeSocket } from "./fake-socket";

let timers: { id: number; ms: number; fn: () => void; live: boolean }[] = [];
const fakeSetTimeout = ((fn: () => void, ms: number) => {
  const t = { id: timers.length + 1, ms, fn, live: true };
  timers.push(t);
  return t.id;
}) as unknown as typeof setTimeout;
const fakeClearTimeout = ((id: number) => {
  const t = timers.find((x) => x.id === id);
  if (t) t.live = false;
}) as unknown as typeof clearTimeout;
const pending = () => timers.filter((t) => t.live);
const fire = () => {
  const t = pending()[0]!;
  t.live = false;
  t.fn();
};

let log: string[];
let msgs: unknown[];
const start = () =>
  openLiveSocket(
    "ws://x/ws",
    { onOpen: () => log.push("open"), onClose: () => log.push("close"), onMessage: (m) => msgs.push(m) },
    { WebSocket: FakeSocket as unknown as typeof WebSocket, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout },
  );

beforeEach(() => {
  FakeSocket.all = [];
  timers = [];
  log = [];
  msgs = [];
});

test("opens and forwards messages", () => {
  const live = start();
  const s = FakeSocket.all[0]!;
  expect(s.url).toBe("ws://x/ws");
  expect(live.hasSocket()).toBe(true);
  s.open();
  s.onmessage!({ data: JSON.stringify({ type: "snapshot" }) });
  s.onmessage!({ data: "not json" });
  expect(log).toEqual(["open"]);
  expect(msgs).toEqual([{ type: "snapshot" }]);
  s.drop();
  expect(live.hasSocket()).toBe(false);
});

test("connectNow() opens at once and keeps the backoff", () => {
  const live = start();
  FakeSocket.all[0]!.drop();
  fire();
  FakeSocket.all[1]!.drop();
  expect(pending()[0]!.ms).toBe(2000);
  live.connectNow();
  expect(pending()).toHaveLength(0);
  expect(FakeSocket.all).toHaveLength(3);
  FakeSocket.all[2]!.drop();
  expect(pending()[0]!.ms).toBe(5000);
});

test("connectNow() does nothing after close()", () => {
  const live = start();
  live.close();
  live.connectNow();
  expect(FakeSocket.all).toHaveLength(1);
});

test("reconnects with backoff 1 s, 2 s, 5 s, 10 s, 10 s", () => {
  start();
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    FakeSocket.all.at(-1)!.drop();
    waits.push(pending()[0]!.ms);
    fire();
  }
  expect(waits).toEqual([1000, 2000, 5000, 10000, 10000]);
  expect(FakeSocket.all).toHaveLength(6);
});

test("an open resets the backoff", () => {
  start();
  FakeSocket.all[0]!.drop();
  fire();
  FakeSocket.all[1]!.drop();
  fire();
  FakeSocket.all[2]!.open();
  FakeSocket.all[2]!.drop();
  expect(pending()[0]!.ms).toBe(1000);
});

test("reconnect() connects at once and drops the pending timer", () => {
  const live = start();
  FakeSocket.all[0]!.drop();
  expect(pending()).toHaveLength(1);
  live.reconnect();
  expect(pending()).toHaveLength(0);
  expect(FakeSocket.all).toHaveLength(2);
  FakeSocket.all[1]!.drop();
  expect(pending()[0]!.ms).toBe(1000);
});

test("send() writes to an open socket only", () => {
  const live = start();
  expect(live.send({ type: "connect" })).toBe(false);
  FakeSocket.all[0]!.open();
  expect(live.send({ type: "connect" })).toBe(true);
  expect(FakeSocket.all[0]!.sent).toEqual(['{"type":"connect"}']);
});

test("close() stops reconnecting", () => {
  const live = start();
  FakeSocket.all[0]!.drop();
  expect(pending()).toHaveLength(1);
  live.close();
  expect(pending()).toHaveLength(0);
  live.reconnect();
  expect(FakeSocket.all).toHaveLength(1);

  const again = start();
  FakeSocket.all.at(-1)!.open();
  again.close();
  expect(log.at(-1)).toBe("close");
  expect(pending()).toHaveLength(0);
});
