import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Noto_Sans_Mono } from "next/font/google";
import "./globals.css";
import "./themes.css";
import ThemeSync from "../components/ThemeSync";
import { THEME_BOOT } from "../lib/theme";

// 正文和标题走系统字体：这两个网页字体只带拉丁子集，中文本来就在用系统字，
// 同一行里两种字形来源还白白多两次字体请求。只保留等宽字体，保证代码块各端一致。
const mono = Noto_Sans_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

// metadata 里的地址不会自动带上 basePath。
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "接驳",
  description: "网页说话，远端动手。",
  manifest: `${base}/manifest.webmanifest`,
  icons: {
    icon: [
      { url: `${base}/favicon.ico`, sizes: "48x48" },
      { url: `${base}/favicon.svg`, type: "image/svg+xml" },
      { url: `${base}/favicon-32.png`, sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: `${base}/apple-touch-icon.png`, sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "接驳",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f3eee4",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="zh-CN" className={mono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <ThemeSync />
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){if(!/canvas-runtime/.test(location.pathname))return;window.__CANVAS_BOOT=window.__CANVAS_BOOT||{q:[]};window.addEventListener("message",function(e){var d=e.data;if(!d||d.type!=="canvas:load")return;window.__CANVAS_BOOT.q.push(d)});try{parent.postMessage({type:"canvas:ready"},"*")}catch(e){}})();',
          }}
        />
        {children}
      </body>
    </html>
  );
}
