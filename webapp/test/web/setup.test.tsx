import { expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { unwrap, client } from "../../src/web/lib/client";
import { renderCount, renderWithQuery, screen, stubFetch, useDom, useUser } from "./setup";

useDom();
const user = useUser();

test("renders inside a QueryClientProvider", () => {
  function Probe() {
    useQueryClient();
    return <p>inside</p>;
  }
  const { getByText, client: queryClient } = renderWithQuery(<Probe />);
  expect(getByText("inside")).toBeTruthy();
  expect(queryClient.getDefaultOptions().queries?.retry).toBe(false);
});

test("renderCount counts renders", () => {
  const { Wrapped, count } = renderCount(({ label }: { label: string }) => <p>{label}</p>);
  const { rerender } = renderWithQuery(<Wrapped label="a" />);
  expect(count()).toBe(1);
  rerender(<Wrapped label="b" />);
  expect(count()).toBe(2);
});

test("stubFetch answers the API client", async () => {
  const body = { service: "connected", printer: "idle", paperInFeeder: true } as const;
  const stub = stubFetch(() => Response.json(body));
  expect(await unwrap(client.api.status.$get())).toEqual(body);
  expect(stub.calls[0]!.url.endsWith("/api/status")).toBe(true);
});

test("useUser clicks in this file's document", async () => {
  const onClick = mock(() => {});
  render(<button onClick={onClick}>Go</button>);
  await user.click(screen.getByRole("button", { name: "Go" }));
  expect(onClick).toHaveBeenCalledTimes(1);
});
