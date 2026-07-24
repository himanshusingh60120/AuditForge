import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuditForge — verified technical SEO audits",
  description:
    "Upload a Screaming Frog crawl. Every issue is re-verified against the live site before it reaches the report.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-ink text-slate-200 antialiased">{children}</body>
    </html>
  );
}
