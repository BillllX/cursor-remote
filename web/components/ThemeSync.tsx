"use client";

import { useLayoutEffect } from "react";
import { applyJieboTheme, readThemeChoice } from "../lib/theme";

/** 水合如果清掉启动脚本写上的属性，在绘制前再套一次。 */
export default function ThemeSync() {
  useLayoutEffect(() => {
    const choice = readThemeChoice();
    applyJieboTheme(choice.palette, choice.appearance);
  }, []);
  return null;
}
