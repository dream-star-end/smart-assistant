import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SettingsRow } from "./SettingsRow";

afterEach(cleanup);

test("390 默认上下排，md 起横排；标题与说明走设置档", () => {
  const { container } = render(
    <SettingsRow title="外观" description="立即生效" action={<button type="button">深色</button>} />,
  );
  const row = container.firstElementChild;
  expect(row).toHaveClass("flex-col");
  expect(row).toHaveClass("md:flex-row");
  expect(screen.getByText("外观")).toHaveClass("text-section");
  expect(screen.getByText("立即生效")).toHaveClass("text-caption", "text-faint");
});
