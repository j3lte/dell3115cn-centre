import { afterEach, expect, test } from "bun:test";
import { LiveHub, type LiveMessage } from "../src/server/live";

const status: LiveMessage = { type: "status", status: { service: "connected", printer: "idle", paperInFeeder: false } };

class FakeSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

test("test_ws_snapshot_on_connect", () => {
  const hub = new LiveHub();
  hub.setSnapshot(() => [status]);
  const ws = new FakeSocket();
  hub.attach(ws);
  expect(ws.sent.map((s) => JSON.parse(s))).toEqual([status]);
});

test("broadcast reaches attached sockets only", () => {
  const hub = new LiveHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.attach(a);
  hub.attach(b);
  hub.detach(b);
  hub.broadcast(status);
  expect(a.sent).toHaveLength(1);
  expect(b.sent).toHaveLength(0);
});

test("client {type:'connect'} asks for a reconnect", () => {
  let asked = 0;
  const hub = new LiveHub(() => asked++);
  hub.message(new FakeSocket(), JSON.stringify({ type: "connect" }));
  hub.message(new FakeSocket(), "not json");
  expect(asked).toBe(1);
});

test("snapshot is the first message over a real WebSocket", async () => {
  const hub = new LiveHub();
  hub.setSnapshot(() => [status]);
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open: (ws) => hub.attach(ws),
      close: (ws) => hub.detach(ws),
      message: (ws, m) => hub.message(ws, String(m)),
    },
  });
  servers.push(server);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
  const first = await new Promise<string>((resolve, reject) => {
    ws.onmessage = (e) => resolve(String(e.data));
    ws.onerror = reject;
  });
  ws.close();
  expect(JSON.parse(first)).toEqual(status);
});
