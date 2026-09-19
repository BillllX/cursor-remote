"use client";

import { transform } from "sucrase";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createCanvasSdk } from "./sdk";

const ALLOWED = new Set(["react", "react/jsx-runtime", "cursor/canvas"]);

export function compileCanvas(source: string) {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Canvas 源码是空的");
  if (/\bfetch\s*\(/.test(trimmed)) throw new Error("Canvas 不能调用 fetch()");
  if (/from\s+['"]\.\.?[/]/.test(trimmed) || /require\s*\(\s*['"]\.\.?[/]/.test(trimmed)) {
    throw new Error("Canvas 不能使用相对导入");
  }
  try {
    const { code } = transform(trimmed, {
      transforms: ["typescript", "jsx", "imports"],
      jsxRuntime: "automatic",
      production: true,
    });
    return code;
  } catch (err) {
    throw new Error(`Canvas 编译失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function loadCanvasModule(code: string): React.ComponentType {
  const sdk = createCanvasSdk();
  const requireMod = (name: string) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    if (name === "cursor/canvas") return sdk;
    throw new Error(`Canvas 不能导入 "${name}"，只允许 cursor/canvas`);
  };
  for (const match of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
    if (!ALLOWED.has(match[1])) {
      throw new Error(`Canvas 不能导入 "${match[1]}"，只允许 cursor/canvas`);
    }
  }
  const module = { exports: {} as { default?: unknown } };
  const fn = new Function("require", "module", "exports", code);
  fn(requireMod, module, module.exports);
  const exported = module.exports.default;
  if (typeof exported !== "function") {
    throw new Error("Canvas 必须 default export 一个组件");
  }
  return exported as React.ComponentType;
}
