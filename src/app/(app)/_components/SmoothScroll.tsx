"use client";

import { useEffect } from "react";

/**
 * App-wide motion, in the landing page's language (Lenis + GSAP ScrollTrigger):
 *  - Lenis smooth scrolling, synced with ScrollTrigger (the journey route draws in step).
 *  - Scroll reveals: editorial blocks rise and fade in as they enter, in batches.
 *  - Gentle parallax on the big serif headings.
 *  - Content that arrives later (live updates) is picked up by a MutationObserver.
 * Every app page gets this through (app)/layout.tsx — no per-page wiring.
 * Skipped entirely for prefers-reduced-motion. Scrollable panels opt out of
 * Lenis with `data-lenis-prevent`; any element can opt out of reveal with `data-no-reveal`.
 */
const REVEAL = [
  ".mz-page-head",
  ".mz-section-head",
  ".mz-panel",
  ".mz-card",
  ".mz-list-item",
  ".mz-stop:not(.is-ghost)",
  ".mz-auth-card",
  ".mz-taxi",
  ".mz-know",
  ".mz-room",
  ".mz-offer",
].join(",");
const PARALLAX = ".mz-h1";

export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let cleanup = () => {};
    let cancelled = false;
    (async () => {
      const [{ default: Lenis }, gsapModule, { ScrollTrigger }] = await Promise.all([import("lenis"), import("gsap"), import("gsap/ScrollTrigger")]);
      if (cancelled) return;
      const gsap = gsapModule.default;
      gsap.registerPlugin(ScrollTrigger);

      const lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
      lenis.on("scroll", ScrollTrigger.update);
      const tick = (time: number) => lenis.raf(time * 1000);
      gsap.ticker.add(tick);
      gsap.ticker.lagSmoothing(0);

      const seen = new WeakSet<Element>();
      const triggers: ScrollTrigger[] = [];
      const revealing = new Set<gsap.core.Tween>();
      // Browsers stop animation frames in hidden tabs; never leave content invisible there.
      const finishReveals = () => revealing.forEach((t) => t.progress(1));
      const onVisibility = () => document.visibilityState === "hidden" && finishReveals();
      document.addEventListener("visibilitychange", onVisibility);
      const reveal = () => {
        const fresh = gsap.utils
          .toArray<HTMLElement>(REVEAL)
          .filter((el) => !seen.has(el) && !el.closest("[data-no-reveal]") && !el.closest(".mz-ribbon-track, .mz-sheet"));
        if (fresh.length && document.visibilityState === "hidden") {
          fresh.forEach((el) => seen.add(el)); // shown as-is: no frames to animate with
        } else if (fresh.length) {
          fresh.forEach((el) => {
            seen.add(el);
            gsap.set(el, { autoAlpha: 0, y: 28 });
          });
          triggers.push(
            ...ScrollTrigger.batch(fresh, {
              start: "top 92%",
              once: true,
              onEnter: (batch) => {
                const t = gsap.to(batch, {
                  autoAlpha: 1,
                  y: 0,
                  duration: 0.9,
                  ease: "power3.out",
                  stagger: 0.08,
                  overwrite: true,
                  clearProps: "transform,opacity,visibility",
                  onComplete: () => void revealing.delete(t),
                });
                revealing.add(t);
                if (document.visibilityState === "hidden") t.progress(1);
              },
            }),
          );
        }
        gsap.utils.toArray<HTMLElement>(PARALLAX).forEach((el) => {
          if (seen.has(el)) return;
          seen.add(el);
          const t = gsap.fromTo(el, { yPercent: 0 }, { yPercent: -18, ease: "none", scrollTrigger: { trigger: el, start: "top 30%", end: "bottom top", scrub: true } });
          if (t.scrollTrigger) triggers.push(t.scrollTrigger);
        });
        ScrollTrigger.refresh();
      };

      reveal();
      let pending = 0;
      const observer = new MutationObserver(() => {
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(reveal);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      cleanup = () => {
        document.removeEventListener("visibilitychange", onVisibility);
        finishReveals();
        observer.disconnect();
        cancelAnimationFrame(pending);
        triggers.forEach((t) => t.kill());
        gsap.ticker.remove(tick);
        lenis.destroy();
      };
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
  return null;
}
