import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./lab.css";

export const metadata: Metadata = {
  title: "接驳 · prompt-kit 测试",
  description: "prompt-kit 风格测试页，不接真实 Agent。",
};

export const viewport: Viewport = {
  themeColor: "#fafafa",
};

export default function LabLayout({ children }: { children: ReactNode }) {
  return children;
}
