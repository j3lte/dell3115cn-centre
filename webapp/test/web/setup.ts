import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, within, type RenderResult } from "@testing-library/react";
import type UserEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { createElement, type ComponentType, type ReactElement, type ReactNode } from "react";

let restoreFetch: (() => void) | undefined;
let restoreClipboard: (() => void) | undefined;
let restoreMedia: (() => void) | undefined;

/**
 * Call at the top of a component test file: registers happy-dom for that file only (server tests in the same run
 * must not see `window`, checked when the file is done), and after each test unmounts what was rendered and puts the
 * real `fetch` and clipboard back.
 */
export function useDom(): void {
  beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3000/" }));
  afterEach(() => {
    cleanup();
    restoreFetch?.();
    restoreFetch = undefined;
    restoreClipboard?.();
    restoreClipboard = undefined;
    restoreMedia?.();
    restoreMedia = undefined;
  });
  afterAll(async () => {
    // React may still have work queued from the last unmount; let it run while `window` exists.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await GlobalRegistrator.unregister();
    // Server tests later in the same run must not see a DOM, whatever order the files run in.
    if (typeof window !== "undefined" || typeof document !== "undefined") throw new Error("happy-dom left window/document behind");
  });
}

/**
 * Testing Library's `screen` for component tests. Its own `screen` (and user-event, and Radix) bind to `document` when
 * imported, before `useDom` registers happy-dom: import those in `beforeAll` and query through this, which looks in
 * `document.body` at call time (Radix portals render there too).
 */
export const screen = new Proxy({} as ReturnType<typeof within>, { get: (_t, k) => Reflect.get(within(document.body), k) });

type User = ReturnType<typeof UserEvent.setup>;

/**
 * Call after `useDom()` in a file that clicks or types. user-event reads `document` when imported, so it is loaded once
 * happy-dom is registered; and Bun shares modules between test files, so every test gets a fresh instance bound to
 * this file's document. Use the returned object like that instance.
 */
export function useUser(): User {
  let userEvent: typeof UserEvent;
  let current: User;
  beforeAll(async () => {
    userEvent = (await import("@testing-library/user-event")).default;
  });
  beforeEach(() => {
    current = userEvent.setup({ document });
  });
  return new Proxy({} as User, { get: (_t, k) => Reflect.get(current, k) });
}

/** Renders `ui` inside a `QueryClientProvider` with a fresh `QueryClient` (no retries) unless one is given. */
export function renderWithQuery(ui: ReactElement, opts: { client?: QueryClient } = {}): RenderResult & { client: QueryClient } {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactNode) => createElement(QueryClientProvider, { client }, node);
  const result = render(wrap(ui));
  return { ...result, client, rerender: (next) => result.rerender(wrap(next)) };
}

/** Wraps a component to count its renders, for the "parent re-render does not re-render it" tests. */
export function renderCount<P extends object>(Component: ComponentType<P>): { Wrapped: ComponentType<P>; count: () => number } {
  let renders = 0;
  const Wrapped = (props: P) => {
    renders++;
    return createElement(Component, props);
  };
  return { Wrapped, count: () => renders };
}

/** Replaces `globalThis.fetch` for the current test so the lazy API client talks to `handler`; `useDom` restores it. */
export function stubFetch(handler: (req: Request) => Response | Promise<Response>): { calls: Request[] } {
  const calls: Request[] = [];
  const original = globalThis.fetch;
  restoreFetch ??= () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { calls };
}

/** Replaces `navigator.clipboard` for the current test (`useDom` puts it back) and returns its `writeText`. */
export function stubClipboard<F extends (text: string) => Promise<void>>(writeText: F): F {
  const old = restoreClipboard ? undefined : Object.getOwnPropertyDescriptor(navigator, "clipboard");
  restoreClipboard ??= () => (old ? Object.defineProperty(navigator, "clipboard", old) : delete (navigator as { clipboard?: unknown }).clipboard);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

/**
 * Replaces `window.matchMedia` for the current test (`useDom` puts it back): every query matches when `matches` is
 * true. `set` changes that and tells the listeners, like a window crossing a breakpoint.
 */
export function stubMedia(matches = false): { set(next: boolean): void; listeners: Set<() => void> } {
  const original = window.matchMedia;
  restoreMedia ??= () => {
    window.matchMedia = original;
  };
  const listeners = new Set<() => void>();
  window.matchMedia = (() => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
  return {
    set(next) {
      matches = next;
      listeners.forEach((l) => l());
    },
    listeners,
  };
}
