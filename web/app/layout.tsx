import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const sans = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "接驳",
  description: "网页说话，远端动手。",
  icons: { icon: "/favicon.svg" },
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
    <html lang="zh-CN" className={sans.variable}>
      <body>
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
