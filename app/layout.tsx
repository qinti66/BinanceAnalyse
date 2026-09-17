import type { Metadata } from "next";
import "./globals.css";
import "@/components/module-nav.css";

export const metadata: Metadata = {
  title: "Alpha Radar｜币安情绪与合约高手雷达",
  description: "追踪币安广场热门币情绪、热度与合约带单员真实风险收益。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className="antialiased">{children}</body></html>;
}
