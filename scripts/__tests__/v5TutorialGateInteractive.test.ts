import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import {
  INTERACTIVE_COMPONENT_NAMES,
  entryIdentityKey,
  isInteractiveJsxName,
  sourceOnlyPolicyErrors,
} from "../check-v5-tutorials.ts";

test("isInteractive includes dropdown menu items and submenu triggers", () => {
  assert.equal(isInteractiveJsxName("button"), true);
  assert.equal(isInteractiveJsxName("Button"), true);
  assert.equal(isInteractiveJsxName("IconButton"), true);
  assert.equal(isInteractiveJsxName("Switch"), true);
  assert.equal(isInteractiveJsxName("DropdownMenuItem"), true);
  assert.equal(isInteractiveJsxName("DropdownMenuSubTrigger"), true);
  assert.equal(INTERACTIVE_COMPONENT_NAMES.has("DropdownMenuItem"), true);
  assert.equal(INTERACTIVE_COMPONENT_NAMES.has("DropdownMenuSubTrigger"), true);
});

test("isInteractive does not treat asChild wrappers or layout as entries", () => {
  assert.equal(isInteractiveJsxName("DropdownMenuTrigger"), false);
  assert.equal(isInteractiveJsxName("DropdownMenuContent"), false);
  assert.equal(isInteractiveJsxName("PopoverTrigger"), false);
  assert.equal(isInteractiveJsxName("div"), false);
  assert.equal(isInteractiveJsxName("span"), false);
});

test("source-only forbids identity drift even when sourceHash also changed", () => {
  const errors = sourceOnlyPolicyErrors({
    sourceChanged: ["chat-basics"],
    identityChanged: ["chat-basics"],
    ids: ["chat-basics"],
    added: [],
    retired: [],
    caseChanged: [],
    registryChanged: [],
  });
  assert.ok(errors.some((item) => item.includes("入口身份变化")));
});

test("source-only requires exact --ids pairing with sourceChanged", () => {
  assert.ok(
    sourceOnlyPolicyErrors({
      sourceChanged: ["chat-basics", "files-media"],
      identityChanged: [],
      ids: [],
      added: [],
      retired: [],
      caseChanged: [],
      registryChanged: [],
    }).some((item) => item.includes("必须用 --ids")),
  );
  assert.ok(
    sourceOnlyPolicyErrors({
      sourceChanged: ["chat-basics", "files-media"],
      identityChanged: [],
      ids: ["chat-basics"],
      added: [],
      retired: [],
      caseChanged: [],
      registryChanged: [],
    }).some((item) => item.includes("必须与功能源变化完全一致")),
  );
  assert.deepEqual(
    sourceOnlyPolicyErrors({
      sourceChanged: ["files-media", "chat-basics"],
      identityChanged: [],
      ids: ["chat-basics", "files-media"],
      added: [],
      retired: [],
      caseChanged: [],
      registryChanged: [],
    }),
    [],
  );
});

test("source-only still forbids capability, case and registry drift", () => {
  assert.ok(
    sourceOnlyPolicyErrors({
      sourceChanged: ["chat-basics"],
      identityChanged: [],
      ids: ["chat-basics"],
      added: ["taskboard"],
      retired: [],
      caseChanged: [],
      registryChanged: [],
    }).some((item) => item.includes("不能接受能力新增或下线")),
  );
  assert.ok(
    sourceOnlyPolicyErrors({
      sourceChanged: ["chat-basics"],
      identityChanged: [],
      ids: ["chat-basics"],
      added: [],
      retired: [],
      caseChanged: ["research-bike-demand"],
      registryChanged: [],
    }).some((item) => item.includes("不能接受场景案例变化")),
  );
  assert.ok(
    sourceOnlyPolicyErrors({
      sourceChanged: ["chat-basics"],
      identityChanged: [],
      ids: ["chat-basics"],
      added: [],
      retired: [],
      caseChanged: [],
      registryChanged: ["chat-basics"],
    }).some((item) => item.includes("不能接受能力标题")),
  );
});

test("entry identity distinguishes asChild and conditional wrapping", () => {
  const source = ts.createSourceFile(
    "x.tsx",
    [
      "const always = <DropdownMenuItem>A</DropdownMenuItem>;",
      "const child = <DropdownMenuItem asChild><a href='/admin'>A</a></DropdownMenuItem>;",
      "const gated = flag && <DropdownMenuItem>A</DropdownMenuItem>;",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const elements: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === "DropdownMenuItem") {
      elements.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(elements.length, 3);
  assert.equal(
    entryIdentityKey("pkg/A.tsx", elements[0]),
    "pkg/A.tsx|DropdownMenuItem|own|always",
  );
  assert.equal(
    entryIdentityKey("pkg/A.tsx", elements[1]),
    "pkg/A.tsx|DropdownMenuItem|asChild|always",
  );
  assert.equal(
    entryIdentityKey("pkg/A.tsx", elements[2]),
    "pkg/A.tsx|DropdownMenuItem|own|conditional",
  );
});
