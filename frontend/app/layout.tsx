import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MU · Micron Technology — Real-Time Quote",
  description: "Real-time MU stock tracker with live price, chart and key statistics.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
