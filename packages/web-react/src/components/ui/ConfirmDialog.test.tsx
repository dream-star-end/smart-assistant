import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { useConfirm } from "./ConfirmDialog";

afterEach(cleanup);

function ConfirmHost({ altText }: { altText?: string }) {
  const [confirm, confirmEl] = useConfirm();
  const [choice, setChoice] = useState("none");
  return (
    <>
      <p data-testid="choice">{choice}</p>
      <button
        type="button"
        onClick={() => {
          void confirm({ title: "切换模型？", confirmText: "压缩并切换", altText }).then((value) => {
            setChoice(String(value));
          });
        }}
      >
        open
      </button>
      {confirmEl}
    </>
  );
}

test("useConfirm still resolves true/false without an alt action", async () => {
  render(<ConfirmHost />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  fireEvent.click(await screen.findByRole("button", { name: "压缩并切换" }));
  expect(await screen.findByTestId("choice")).toHaveTextContent("true");
});

test("useConfirm exposes a direct-switch alt action", async () => {
  render(<ConfirmHost altText="直接切换" />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  fireEvent.click(await screen.findByRole("button", { name: "直接切换" }));
  expect(await screen.findByTestId("choice")).toHaveTextContent("alt");
});
