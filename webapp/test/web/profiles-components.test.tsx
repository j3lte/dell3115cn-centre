import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, render, waitFor, within } from "@testing-library/react";
import { SMB_RETIRED } from "../../src/server/destinations/smb";
import { DEST_FIELDS, MASK } from "../../src/web/helpers/profiles";
import { keys } from "../../src/web/lib/query";
import type { OutputProfile } from "../../src/web/types/api";
import { endpoint, FEEDER, noop, path } from "./fixtures";
import { renderCount, renderWithQuery, screen, stubFetch, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix reads `document` when imported: load every component that imports Radix after happy-dom is registered.
let ProfileList: typeof import("../../src/web/components/profiles/ProfileList").ProfileList;
let FormShell: typeof import("../../src/web/components/profiles/FormShell").FormShell;
let OutputProfileForm: typeof import("../../src/web/components/profiles/OutputProfileForm").OutputProfileForm;
let DestinationField: typeof import("../../src/web/components/profiles/DestinationField").DestinationField;
let MultilineSecretField: typeof import("../../src/web/components/profiles/MultilineSecretField").MultilineSecretField;
let HostKeyField: typeof import("../../src/web/components/profiles/HostKeyField").HostKeyField;
let CommonProfiles: typeof import("../../src/web/components/profiles/CommonProfiles").CommonProfiles;
let ProfilesPage: typeof import("../../src/web/pages/ProfilesPage").ProfilesPage;
let useProfiles: typeof import("../../src/web/hooks/useProfiles").useProfiles;
beforeAll(async () => {
  ({ ProfileList } = await import("../../src/web/components/profiles/ProfileList"));
  ({ FormShell } = await import("../../src/web/components/profiles/FormShell"));
  ({ OutputProfileForm } = await import("../../src/web/components/profiles/OutputProfileForm"));
  ({ DestinationField } = await import("../../src/web/components/profiles/DestinationField"));
  ({ MultilineSecretField } = await import("../../src/web/components/profiles/MultilineSecretField"));
  ({ HostKeyField } = await import("../../src/web/components/profiles/HostKeyField"));
  ({ CommonProfiles } = await import("../../src/web/components/profiles/CommonProfiles"));
  ({ ProfilesPage } = await import("../../src/web/pages/ProfilesPage"));
  ({ useProfiles } = await import("../../src/web/hooks/useProfiles"));
});

afterEach(() => {
  location.hash = "";
});

/** The form's own requests: without the features it loads to know the retired destinations. */
const apiCalls = (stub: { calls: Request[] }) => stub.calls.filter((r) => path(r) !== "/api/features");

describe("ProfileList", () => {
  test("ProfileList marks the selected profile and reports a click", async () => {
    const onNew = mock(noop);
    const items = [
      { id: 1, name: "Letters", sub: "Feeder · Gray" },
      { id: 2, name: "Photos", sub: "Flatbed · Colour" },
    ];
    render(<ProfileList kind="in" items={items} selectedId={2} onNew={onNew} />);
    expect(screen.getByRole("heading", { name: "Input profiles" })).toBeTruthy();
    const photos = screen.getByRole("link", { name: /Photos/ });
    expect(photos.getAttribute("aria-current")).toBe("true");
    expect(photos.getAttribute("href")).toBe("#/profiles/in/2");
    expect(screen.getByRole("link", { name: /Letters/ }).getAttribute("aria-current")).toBeNull();
    await user.click(screen.getByRole("button", { name: "+ New" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  test("ProfileRow does not re-render when the list re-renders with the same profile", () => {
    // The row reads `name` while rendering; a skipped render doesn't.
    let reads = 0;
    const item = {
      id: 1,
      get name() {
        reads++;
        return "Letters";
      },
      sub: "Feeder · Gray",
    };
    const { Wrapped, count } = renderCount(ProfileList);
    const { rerender } = render(<Wrapped kind="in" items={[item]} selectedId={null} onNew={noop} />);
    const first = reads;
    rerender(<Wrapped kind="in" items={[item]} selectedId={null} onNew={noop} />);
    expect(count()).toBe(2);
    expect(reads).toBe(first);
    rerender(<Wrapped kind="in" items={[item]} selectedId={1} onNew={noop} />);
    expect(reads).toBeGreaterThan(first);
  });
});

describe("forms", () => {
  test("FormShell saves on submit and deletes only after confirming", async () => {
    const onSave = mock(noop);
    const onDelete = mock(noop);
    render(
      <FormShell title="Input profile: Letters" saving={false} onSave={onSave} onDelete={onDelete}>
        <p>fields</p>
      </FormShell>,
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test("InputProfileForm keeps unsaved edits when the profile list refetches", async () => {
    location.hash = "#/profiles/in/1";
    // The refetch answers the list as another device saved it: a fresh profile object (600 dpi), the name unchanged.
    let lists = 0;
    const stub = stubFetch((req) => {
      if (path(req) === "/api/input-profiles") return Response.json([lists++ === 0 ? FEEDER : { ...FEEDER, dpi: 600 }]);
      if (path(req) === "/api/output-profiles") return Response.json([]);
      return Response.json({});
    });
    function Page() {
      return <ProfilesPage profiles={useProfiles()} />;
    }
    const { client } = renderWithQuery(<Page />);
    const name = (await screen.findByRole("textbox", { name: "Name" })) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "Letters (gray 300)");
    await act(() => client.invalidateQueries({ queryKey: keys.inputProfiles }));
    expect(stub.calls.filter((r) => path(r) === "/api/input-profiles").length).toBe(2);
    expect(await screen.findByText("Feeder · Gray · 600 dpi · A4")).toBeTruthy();
    await act(async () => {});
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Letters (gray 300)");
  });

  const features = { analyse: false, retiredDestinations: { smb: SMB_RETIRED } };
  const KEY = `SHA256:${"k".repeat(43)}`;

  test("OutputProfileForm offers no retired destination once the server has said which", async () => {
    stubFetch((req) => (path(req) === "/api/features" ? Response.json(features) : Response.json({})));
    renderWithQuery(<OutputProfileForm profile={null} />);
    const picker = screen.getByRole("combobox", { name: "Destination" });
    const names = () => [...(picker as HTMLSelectElement).options].map((o) => o.textContent);
    await waitFor(() => expect(names()).not.toContain("SMB share"));
    expect(names()).toContain("SFTP (SSH)");
  });

  test("OutputProfileForm shows the SFTP fields: the private key as a text area, the password hidden", async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    renderWithQuery(<OutputProfileForm profile={null} />);
    expect(screen.queryByLabelText("Host")).toBeNull();
    await user.selectOptions(screen.getByRole("combobox", { name: "Destination" }), "sftp");
    for (const f of DEST_FIELDS.sftp) expect(screen.getByLabelText(f.label)).toBeTruthy();
    expect(screen.getByLabelText("Private key").tagName).toBe("TEXTAREA");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    expect(screen.queryByText("Host key")).toBeNull(); // no host yet
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
  });

  test("MultilineSecretField shows a stored key as empty and keeps it when left untouched", async () => {
    const onChange = mock((_v: unknown) => {});
    render(<MultilineSecretField spec={{ key: "privateKey", label: "Private key", kind: "secret", multiline: true }} value={MASK} onChange={onChange} />);
    const pem = screen.getByLabelText("Private key") as HTMLTextAreaElement;
    expect(pem.value).toBe("");
    expect(pem.placeholder).toBe("Saved — paste to replace");
    await user.click(pem);
    await user.tab();
    expect(onChange).toHaveBeenCalledWith(MASK);
  });

  test("HostKeyField shows the key trusted for host:port and forgets it", async () => {
    let stored = true;
    const stub = stubFetch((req) => {
      if (req.method === "DELETE") return ((stored = false), new Response(null, { status: 204 }));
      return stored ? Response.json({ host: "nas.example", port: 2222, fingerprint: KEY, firstSeen: 1 }) : Response.json({ error: "not_found", message: "none" }, { status: 404 });
    });
    renderWithQuery(<HostKeyField host="nas.example" port={2222} />);
    expect(await screen.findByText(KEY)).toBeTruthy();
    expect(new URL(stub.calls[0]!.url).search).toBe("?host=nas.example&port=2222");
    await user.click(screen.getByRole("button", { name: "Forget host key" }));
    expect(await screen.findByText(/Not stored yet/)).toBeTruthy();
    expect(stub.calls.map(endpoint)).toContain("DELETE /api/host-keys");
  });

  test("a Test of an SFTP destination shows the host key it trusted", async () => {
    const server = {
      ...archive,
      destination: { type: "sftp", config: { host: "files.example", port: 22, username: "u", password: MASK } },
    } as unknown as OutputProfile;
    let trusted = false;
    stubFetch((req) => {
      if (path(req) === "/api/destinations/test") return ((trusted = true), Response.json({ ok: true }));
      if (path(req) === "/api/host-keys" && trusted) return Response.json({ host: "files.example", port: 22, fingerprint: KEY, firstSeen: 1 });
      return Response.json({ error: "not_found", message: "none" }, { status: 404 });
    });
    renderWithQuery(<OutputProfileForm profile={server} />);
    expect(await screen.findByText(/Not stored yet/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(KEY)).toBeTruthy();
  });

  test("an SMB profile from an older version shows as no longer supported and can be switched", async () => {
    stubFetch((req) => (path(req) === "/api/features" ? Response.json(features) : Response.json({})));
    const old = { ...archive, destination: { type: "smb", config: { server: "nas", share: "s", password: MASK } } } as unknown as OutputProfile;
    renderWithQuery(<OutputProfileForm profile={old} />);
    const picker = screen.getByRole("combobox", { name: "Destination" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.selectedOptions[0]!.textContent).toBe("SMB share (no longer supported)"));
    expect(screen.getByText(SMB_RETIRED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();
    await user.selectOptions(picker, "sftp");
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(screen.queryByText(SMB_RETIRED)).toBeNull();
  });

  const archive = {
    id: 5,
    name: "Archive",
    format: "pdf_multi",
    jpegQuality: 80,
    filenameTemplate: "{date}_scan",
    destination: { type: "paperless", config: { url: "http://paperless.example", token: MASK } },
  } as unknown as OutputProfile;

  test("OutputProfileForm tests the destination with the profile's id and forgets the answer when the destination changes", async () => {
    let answer = () => Response.json({ ok: true });
    const stub = stubFetch((req) => (path(req) === "/api/destinations/test" ? answer() : Response.json(features)));
    renderWithQuery(<OutputProfileForm profile={archive} />);
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("✓ Connection works.")).toBeTruthy();
    const tested = apiCalls(stub)[0]!;
    expect(path(tested)).toBe("/api/destinations/test");
    expect(await tested.json()).toEqual({ type: "paperless", config: { url: "http://paperless.example", token: MASK }, id: 5 });

    await user.type(screen.getByLabelText("Paperless URL"), "/x");
    expect(screen.queryByText("✓ Connection works.")).toBeNull();

    answer = () => Response.json({ error: "test_failed", message: "401 Unauthorized" }, { status: 422 });
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect((await screen.findByRole("alert")).textContent).toContain("401 Unauthorized");
  });

  test("a new output profile opens its own page after saving, which says Saved.", async () => {
    const stub = stubFetch(() => Response.json({ ...archive, id: 9 }));
    const { unmount } = renderWithQuery(<OutputProfileForm profile={null} />);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Archive");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location.hash).toBe("#/profiles/out/9"));
    expect(apiCalls(stub).map(endpoint)).toEqual(["POST /api/output-profiles"]);
    // The page for the new id mounts a fresh form, which takes the flash.
    unmount();
    renderWithQuery(<OutputProfileForm profile={{ ...archive, id: 9 }} />);
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  test("deleting an output profile goes back to the list", async () => {
    const stub = stubFetch(() => new Response(null, { status: 204 }));
    renderWithQuery(<OutputProfileForm profile={archive} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(apiCalls(stub)).toEqual([]);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(location.hash).toBe("#/profiles"));
    expect(apiCalls(stub).map(endpoint)).toEqual(["DELETE /api/output-profiles/5"]);
  });

  test("DestinationField shows a masked secret as the mask", async () => {
    const onChange = mock((_v: unknown) => {});
    render(<DestinationField spec={{ key: "password", label: "Password", kind: "secret" }} value={MASK} onChange={onChange} />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Saved — type to replace");
    expect(screen.getByText("A value is saved. Leave empty to keep it.")).toBeTruthy();
    // Leaving it untouched keeps the stored secret.
    await user.click(input);
    await user.tab();
    expect(onChange).toHaveBeenCalledWith(MASK);
  });
});

describe("CommonProfiles", () => {
  test("CommonProfiles reports how many were added", async () => {
    stubFetch((req) => {
      if (path(req) === "/api/profiles/common" && req.method === "POST") return Response.json({ input: 1, output: 0 });
      return Response.json([]);
    });
    renderWithQuery(<CommonProfiles />);
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Added 1 input and 0 output profiles.")).toBeTruthy();
  });
});
