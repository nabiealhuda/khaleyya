import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "خَلِيّة — فريقك الكامل.. لقرارات أذكى",
  description: "منصة خَلِيّة لإدارة القرارات الذكية للمتاجر الإلكترونية",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
