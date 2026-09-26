import type { Metadata, Viewport } from "next";
import "./app.css";
import "./app.functional.css";

export const metadata: Metadata = {
  title: "Musafir",
  description: "A self-healing travel companion for travellers and operators.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fbf8f3",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="mz-app">{children}</div>;
}
