import { TornEdge } from "./TornEdge";

/**
 * The obsidian "When plans break" band with torn paper edges top and bottom.
 * Everything inside inherits dark-mode `mz-*` tokens, so existing panels and cards restyle themselves.
 */
export function DarkBand({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <section className="mz-band" aria-label={label}>
      <TornEdge flip />
      <div className="mz-band-inner">{children}</div>
      <TornEdge />
    </section>
  );
}
