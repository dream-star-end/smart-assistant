import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./DropdownMenu";

afterEach(cleanup);

describe("DropdownMenu short-viewport height cap (OCV5-778)", () => {
  it("caps DropdownMenuContent and DropdownMenuSubContent to Radix available height with vertical scroll (INC-20261117-DROPDOWN-SHORT-VIEWPORT-CLIP)", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">更多</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-testid="main-menu">
          <DropdownMenuItem>新建会话</DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>移至项目</DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="sub-menu">
              <DropdownMenuItem>外协采购</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const mainMenu = screen.getByTestId("main-menu");
    const subMenu = screen.getByTestId("sub-menu");

    for (const menu of [mainMenu, subMenu]) {
      expect(menu.className).toContain("max-h-[var(--radix-dropdown-menu-content-available-height)]");
      expect(menu.className).toContain("overflow-y-auto");
      expect(menu.className).toContain("overflow-x-hidden");
      expect(menu.className).toContain("overscroll-contain");
      expect(menu.className).not.toContain("overflow-hidden");
    }
  });

  it("allows callers with custom inner scroll containers to override max-h and overflow via className", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <button type="button">选择模型</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-testid="model-menu" className="flex max-h-[80vh] flex-col overflow-hidden">
          <DropdownMenuItem>GPT-6</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const menu = screen.getByTestId("model-menu");
    expect(menu.className).toContain("max-h-[80vh]");
    expect(menu.className).not.toContain("max-h-[var(--radix-dropdown-menu-content-available-height)]");
    expect(menu.className).toContain("overflow-hidden");
  });
});
