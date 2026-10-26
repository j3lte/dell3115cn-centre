import { beforeAll, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { useState } from "react";
import { screen, useDom, useUser } from "./setup";

useDom();
const user = useUser();

// Radix (layout-effect choice, Portal) inspects `document` when imported: load it after registration and query through
// setup's `screen`.
let DellMfpIcon: typeof import("../../src/web/components/icons/DellMfpIcon").DellMfpIcon;
let Confirm: typeof import("../../src/web/components/ui/Confirm").Confirm;
let Segmented: typeof import("../../src/web/components/ui/Segmented").Segmented;
let Sheet: typeof import("../../src/web/components/ui/Sheet").Sheet;
let Slider: typeof import("../../src/web/components/ui/Slider").Slider;
let Toggle: typeof import("../../src/web/components/ui/Toggle").Toggle;
beforeAll(async () => {
  ({ DellMfpIcon } = await import("../../src/web/components/icons/DellMfpIcon"));
  ({ Confirm } = await import("../../src/web/components/ui/Confirm"));
  ({ Segmented } = await import("../../src/web/components/ui/Segmented"));
  ({ Sheet } = await import("../../src/web/components/ui/Sheet"));
  ({ Slider } = await import("../../src/web/components/ui/Slider"));
  ({ Toggle } = await import("../../src/web/components/ui/Toggle"));
});

describe("primitives", () => {
  test("Toggle calls onChange with the new value", async () => {
    const onChange = mock((_v: boolean) => {});
    render(<Toggle label="Duplex" checked={false} onChange={onChange} />);
    await user.click(screen.getByRole("switch", { name: "Duplex" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test("Segmented marks the selected option and reports a click", async () => {
    const onChange = mock((_v: string) => {});
    render(
      <Segmented
        label="Mode"
        value="a"
        options={[
          ["a", "Alpha"],
          ["b", "Beta"],
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("radio", { name: "Alpha" }).getAttribute("data-state")).toBe("on");
    expect(screen.getByRole("radio", { name: "Beta" }).getAttribute("data-state")).toBe("off");
    await user.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  test("Slider shows its value", () => {
    render(<Slider label="Contrast" value={42} min={0} max={100} onChange={() => {}} />);
    expect(screen.getByText("42").tagName).toBe("OUTPUT");
    expect(screen.getByRole("slider", { name: "Contrast" })).toBeTruthy();
  });
});

function ConfirmHost({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(true);
  return <Confirm open={open} onOpenChange={setOpen} title="Delete?" body="Sure?" confirmLabel="Delete" onConfirm={onConfirm} />;
}

describe("dialogs", () => {
  test("Confirm runs the action only on confirm", async () => {
    const cancel = mock(() => {});
    const { unmount } = render(<ConfirmHost onConfirm={cancel} />);
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    const esc = mock(() => {});
    render(<ConfirmHost onConfirm={esc} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(esc).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Confirm button runs the action once", async () => {
    const onConfirm = mock(() => {});
    render(<ConfirmHost onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Sheet closes on Escape", async () => {
    const onOpenChange = mock((_v: boolean) => {});
    render(
      <Sheet open onOpenChange={onOpenChange} title="Panel">
        body
      </Sheet>,
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("icons", () => {
  test("DellMfpIcon draws icon B", () => {
    const { container } = render(<DellMfpIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    const rects = [...svg.querySelectorAll("rect")].map((r) => ["x", "y", "width", "height", "rx"].map((a) => r.getAttribute(a)));
    expect(rects).toEqual([
      ["4", "3.5", "16", "4.5", "1"],
      ["4", "12.5", "16", "8", "1.5"],
    ]);
    expect(svg.querySelector("path")!.getAttribute("d")).toBe("M5.5 8v4.5");
    const c = svg.querySelector("circle")!;
    expect([c.getAttribute("cx"), c.getAttribute("cy"), c.getAttribute("r")]).toEqual(["15", "16.5", "1"]);
    expect(svg.children.length).toBe(4);
  });
});
