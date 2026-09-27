import type { Metadata, Viewport } from "next";
import "./app.css";
import "./app.functional.css";
import { getSessionUser } from "@/server/auth.ts";
import { whatsappContact } from "@/server/whatsapp.ts";
import { SmoothScroll } from "./_components/SmoothScroll";
import { WhatsAppHelp } from "./_components/WhatsAppHelp";

export const metadata: Metadata = {
  title: "Musafir",
  description: "A self-healing travel companion for travellers and operators.",
  // Installed on iPhone ("Add to Home Screen") it opens full-screen like an app.
  appleWebApp: { capable: true, title: "Musafir", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fbf8f3",
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Travellers (guests included) get the WhatsApp on-ground assistant on every screen; operators don't.
  const user = await getSessionUser().catch(() => null);
  const wa = user?.role === "traveller" ? await whatsappContact() : null;
  return (
    <div className="mz-app">
      <SmoothScroll />
      {children}
      {wa && <WhatsAppHelp number={wa.number} name={wa.name} />}
    </div>
  );
}
