/**
 * The WhatsApp on-ground assistant's public number, for the traveller's
 * "Help on WhatsApp" button. WHATSAPP_DISPLAY_NUMBER (or WHATSAPP_NUMBER) wins; otherwise it is
 * read once an hour from Meta's Graph API with the bot's own credentials.
 * No number known → null, and the button isn't shown (never a guessed number).
 */
const TTL_MS = 60 * 60_000;
const g = globalThis as typeof globalThis & { __musafirWa?: { at: number; value: WhatsAppContact | null } };

export interface WhatsAppContact {
  /** Digits only, international format, for wa.me links. */
  number: string;
  name?: string;
}

export async function whatsappContact(): Promise<WhatsAppContact | null> {
  const fixed = (process.env.WHATSAPP_DISPLAY_NUMBER || process.env.WHATSAPP_NUMBER || "").replace(/\D/g, "");
  if (fixed.length >= 8) return { number: fixed, name: process.env.WHATSAPP_DISPLAY_NAME || undefined };
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !id) return null;
  if (g.__musafirWa && Date.now() - g.__musafirWa.at < TTL_MS) return g.__musafirWa.value;
  let value: WhatsAppContact | null = null;
  try {
    const version = process.env.WHATSAPP_API_VERSION || "v25.0";
    const res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(id)}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const b = (await res.json()) as { display_phone_number?: string; verified_name?: string };
      const digits = (b.display_phone_number ?? "").replace(/\D/g, "");
      if (digits.length >= 8) value = { number: digits, name: b.verified_name };
    }
  } catch {
    /* Meta unreachable or token expired: no button rather than a wrong number */
  }
  g.__musafirWa = { at: Date.now(), value };
  return value;
}
