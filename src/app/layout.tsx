import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Musafir | Redefining Travel for a Modern World",
  description:
    "We manage travel end to end for individuals and businesses. As your travel partner, we take care of every detail, so you can focus on what really matters.",
  icons: {
    icon: "https://cdn.prod.website-files.com/697797a5e8e563920247d163/6983e7c5ac59ad91661fed9f_favicon32.png",
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
