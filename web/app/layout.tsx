import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Noto_Sans_SC } from "next/font/google";
import "./globals.css";
import "./themes.css";
import ThemeSync from "../components/ThemeSync";
import { THEME_BOOT } from "../lib/theme";

const sans = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "接驳",
  description: "网页说话，远端动手。",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
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
  themeColor: "#fafafa",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="zh-CN" className={sans.variable} suppressHydrationWarning>
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
