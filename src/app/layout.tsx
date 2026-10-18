import type { Metadata } from "next";
import { Geist, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-geist",
  adjustFontFallback: true,
});

/** Chinese is in the downloaded unicode-range slices, not a named fallback that never loads. */
const notoSansSc = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-noto-sc",
  preload: false,
  adjustFontFallback: true,
});

export const metadata: Metadata = {
  title: "Asset Dashboard",
  description: "资产看板",
  icons: { icon: "/avatar.jpg", apple: "/avatar.jpg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth" className={`${geist.variable} ${notoSansSc.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
