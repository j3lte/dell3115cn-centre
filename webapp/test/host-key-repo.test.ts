import { expect, test } from "bun:test";
import { openDb } from "../src/server/db";
import { HostKeyRepo } from "../src/server/repos/host-key-repo";
import { fakeFingerprint } from "./helpers";

test("one trusted key per host and port; the first one stays until forgotten", () => {
  let now = 1000;
  const repo = new HostKeyRepo(openDb(":memory:"), () => now);
  expect(repo.get("nas.example", 22)).toBeNull();
  expect(repo.set("nas.example", 22, fakeFingerprint("a"))).toBe(fakeFingerprint("a"));
  now = 2000;
  // A second first use (two connections at once) doesn't replace it, and learns which key won.
  expect(repo.set("nas.example", 22, fakeFingerprint("b"))).toBe(fakeFingerprint("a"));
  repo.set("nas.example", 2222, fakeFingerprint("c"));
  expect(repo.get("nas.example", 22)).toEqual({ fingerprint: fakeFingerprint("a"), firstSeen: 1000 });
  expect(repo.get("NAS.example", 22)?.fingerprint).toBe(fakeFingerprint("a")); // host names ignore case
  expect(repo.get("nas.example", 2222)?.fingerprint).toBe(fakeFingerprint("c"));
  repo.forget("nas.example", 22);
  expect(repo.get("nas.example", 22)).toBeNull();
  expect(repo.get("nas.example", 2222)).not.toBeNull();
});
