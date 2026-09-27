"use client";

import { useEffect } from "react";

/** "Save as PDF" for the printable itinerary. With `auto`, opens the dialog on arrival. */
export function PrintButton({ auto = false }: { auto?: boolean }) {
  useEffect(() => {
    if (!auto) return;
    // Let fonts and the map settle so the PDF isn't captured mid-load.
    const t = setTimeout(() => {
      void document.fonts?.ready.then(() => window.print());
    }, 400);
    return () => clearTimeout(t);
  }, [auto]);
  return (
    <button type="button" className="mz-btn mz-btn-solid" onClick={() => window.print()}>
      Save as PDF
    </button>
  );
}
