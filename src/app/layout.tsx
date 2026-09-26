import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Musafir | Redefining Travel for a Modern World",
  description:
    "We manage travel end to end for individuals and businesses. As your travel partner, we take care of every detail, so you can focus on what really matters.",
  icons: {
    icon: "/icon.svg",
  },
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
