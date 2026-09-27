"use client";

import React, { useEffect, useRef, useState } from "react";
import Lenis from "lenis";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { HeroMask } from "./components/HeroMask";
import { GridSvg } from "./components/GridSvg";
import { StarSvg } from "./components/StarSvg";
import { TransitionGridSvg } from "./components/TransitionGridSvg";
import { JourneySection } from "./components/JourneySection";
import { TestimonialsSection } from "./components/TestimonialsSection";
import { FooterSection } from "./components/FooterSection";
import { SiteNav } from "./components/SiteNav";

// Resting width of the Asia cutout, matched by .hero_mask-inner in globals.css.
const HERO_MASK_REST_VW = 145;
// Phones are tall and narrow: start larger so Asia fills the screen behind the
// heading, and open proportionally further (desktop 145 → 750).
const HERO_MASK_REST_VW_PHONE = 380;
const HERO_MASK_END_VW = 750;
const HERO_MASK_END_VW_PHONE = 1960;

export default function MusafirExperience() {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomImgRef = useRef<HTMLImageElement>(null);
  const topImgRef = useRef<HTMLImageElement>(null);
  const maskInnerRef = useRef<HTMLDivElement>(null);
  const topTextRef = useRef<HTMLDivElement>(null);
  const homeTransitionSectionRef = useRef<HTMLElement>(null);
  const homeTransitionBgRef = useRef<HTMLImageElement>(null);
  const travelSectionRef = useRef<HTMLElement>(null);
  const travelBottomBgRef = useRef<HTMLImageElement>(null);
  const journeySectionRef = useRef<HTMLDivElement>(null);
  const [navTheme, setNavTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);

    // 1. Lenis drives the scroll, GSAP's ticker drives Lenis. One clock for
    //    both means ScrollTrigger (the journey route draw) updates in the same
    //    frame the page moves, instead of trailing it by a frame.
    const lenis = new Lenis({
      lerp: 0.08,
      smoothWheel: true,
    });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.lagSmoothing(0);

    let lastNavTheme: "light" | "dark" = "light";

    // 2. Per-frame effects. All layout reads happen first, then all writes, so
    //    the browser lays the page out once per frame instead of three times.
    const update = (time: number) => {
      lenis.raf(time * 1000);

      // ---- reads ----
      const scrollY = window.scrollY;
      const viewportHeight = window.innerHeight;
      const transitionRect = homeTransitionSectionRef.current?.getBoundingClientRect();
      const travelRect = travelSectionRef.current?.getBoundingClientRect();
      const journeyTop = journeySectionRef.current?.getBoundingClientRect().top;

      // ---- derived values ----
      // Hero mask zoom (Webflow a-8: 0 -> 35% of the 100vh scroll range)
      const maskProgress = Math.min(Math.max(scrollY / (viewportHeight * 0.35), 0), 1);
      // Rests at 145vw so Asia fills the first view, then zooms to 750vw.
      const phone = window.innerWidth < 768;
      const rest = phone ? HERO_MASK_REST_VW_PHONE : HERO_MASK_REST_VW;
      const end = phone ? HERO_MASK_END_VW_PHONE : HERO_MASK_END_VW;
      const maskWidth = rest + maskProgress * (end - rest);
      const bgScale = 1.2 - maskProgress * 0.2; // 1.2 -> 1.0
      const heroInView = scrollY < viewportHeight * 2;

      // ---- writes ----
      if (heroInView) {
        const maskInner = maskInnerRef.current;
        if (maskInner) {
          maskInner.style.width = `${maskWidth}vw`;
          if (maskProgress >= 0.95) {
            maskInner.style.opacity = "0";
            maskInner.style.display = "none";
          } else {
            maskInner.style.display = "flex";
            maskInner.style.opacity =
              maskProgress > 0.65 ? `${1 - (maskProgress - 0.65) / 0.3}` : "1";
          }
        }

        // The hero photo is static: no pointer tracking, only the scroll zoom.
        if (bottomImgRef.current) {
          bottomImgRef.current.style.transform = `scale(${bgScale})`;
        }

        if (topImgRef.current) {
          topImgRef.current.style.transform = `scale(${bgScale})`;
        }

        if (topTextRef.current) {
          topTextRef.current.style.opacity = `${Math.max(1 - maskProgress * 1.8, 0)}`;
          topTextRef.current.style.transform = `translate3d(0, ${-maskProgress * 40}px, 0)`;
        }
      }

      // Section transition parallax (Webflow a-18: 3rem -> -3rem)
      if (homeTransitionBgRef.current && transitionRect) {
        const progress = Math.min(
          Math.max((viewportHeight - transitionRect.top) / (viewportHeight + transitionRect.height), 0),
          1
        );
        homeTransitionBgRef.current.style.transform = `translate3d(0, ${3 - progress * 6}rem, 0)`;
      }

      // Travel bottom torn edge parallax (Webflow a-19: 2rem -> 0rem)
      if (travelBottomBgRef.current && travelRect) {
        const progress = Math.min(
          Math.max((viewportHeight - travelRect.top) / (viewportHeight + travelRect.height), 0),
          1
        );
        travelBottomBgRef.current.style.transform = `translate3d(0, ${2 - progress * 2}rem, 0)`;
      }

      // Nav theme: dark text on the paper hero and journey, white over photos
      const nextTheme: "light" | "dark" =
        journeyTop !== undefined && journeyTop <= 60 ? "light" : scrollY > 120 ? "dark" : "light";
      if (nextTheme !== lastNavTheme) {
        lastNavTheme = nextTheme;
        setNavTheme(nextTheme);
      }
    };

    gsap.ticker.add(update);

    return () => {
      gsap.ticker.remove(update);
      lenis.destroy();
    };
  }, []);

  const isDarkNav = navTheme === "dark";

  return (
    <div className="page-wrapper">
      {/* 1. TOP NAVIGATION */}
      <SiteNav dark={isDarkNav} />

      {/* 2. SECTION HERO (200vh STICKY SCROLL WITH ORGANIC CUTOUT MASK) */}
      <main className="section_hero" ref={containerRef}>
        <div className="hero_content-wrapper">
          {/* Sticky Viewport Frame */}
          <div className="hero_sticky">
            <div className="hero_content">
              {/* Nautical / Astrolabe Coordinate Grid */}
              <div className="grid">
                <GridSvg />
              </div>

              {/* Dual 8-Point Compass Stars */}
              <div className="hero_stars">
                <div className="hero_star">
                  <StarSvg />
                </div>
                <div className="hero_star">
                  <StarSvg />
                </div>
              </div>

              {/* 2.5D Layered Background Imagery */}
              <div className="hero_bg">
                <img
                  ref={bottomImgRef}
                  src="/images/hero-bottom.avif"
                  alt="Sea view at the horizon"
                  className="hero_bg-img is-bottom"
                />
                <img
                  ref={topImgRef}
                  src="/images/hero-top.avif"
                  alt="Traveller looking out at the horizon"
                  className="hero_bg-img is-top"
                />
              </div>

              {/* Inverted Island / Archipelago Cutout Mask */}
              <div className="hero_mask-wrapper">
                <div className="hero_mask-inner" ref={maskInnerRef}>
                  <div className="hero_mask-top" />
                  <HeroMask className="hero_mask-new" />
                  <div className="hero_mask-bottom" />
                </div>
              </div>
            </div>
          </div>

          {/* Scrollable Narrative Typography Layer as sibling of hero_sticky */}
          <div className="hero_scrollable">
            {/* Phase 1: Center Cutout Typography (Screenshot 1) */}
            <div className="hero_scrollable-top" ref={topTextRef}>
              <h1 className="heading-style-h3">
                WITH YOU AT
                <br />
                EVERY HORIZON
              </h1>
              <p className="text-size-medium">
                We manage travel end to end for individuals and businesses. As
                your travel partner, we take care of every detail, so you can
                focus on what really matters.
              </p>
              <a
                href="#discover"
                className="button is-hero-discover"
                onClick={(e) => {
                  e.preventDefault();
                  window.scrollTo({
                    top: window.innerHeight,
                    behavior: "smooth",
                  });
                }}
              >
                DISCOVER
              </a>
            </div>

            {/* Phase 2: Full Screen Revealed Narrative (Screenshot 2) */}
            <div id="discover" className="hero_scrollable-bottom">
              <h2 className="heading-style-h1">
                WE MAKE COMPLEX
                <br />
                TRAVEL SIMPLE
              </h2>
              <div className="hero_scrollable-bottom-text">
                <p>
                  We don’t just arrange flights and hotels.
                  <br />
                  <br />
                  We manage the entire journey — before, during, and after travel
                  — anticipating needs, resolving issues proactively, and
                  ensuring every trip runs smoothly.
                  <br />
                  <br />
                  From frequent business travel to once-in-a-lifetime journeys,
                  Musafir operates as an extension of your world.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* 3. SECTION HOME-TRANSITION ("TRAVEL DESIGNED AROUND YOU" - SCREENSHOT 3) */}
      <section className="section_home-transition is-static" ref={homeTransitionSectionRef}>
        <div className="padding-global padding-section-large is-relative-11 is-xxl">
          <div className="container-max">
            <div className="home-transition_content">
              <h2 className="heading-style-h1 is-mobile-48 is-stroke-white">
                TRAVEL DESIGNED <br />
                AROUND YOU
              </h2>
            </div>
          </div>
        </div>

        {/* Coordinate Chart Grid Overlay */}
        <div className="grid">
          <TransitionGridSvg />
        </div>

        {/* Right Island Vector Line Chart */}
        <img
          src="/images/transition-map.svg"
          alt="Island Nautical Map Chart"
          className="home-transition_img-right"
        />

        {/* Dark Silhouette Organic Mountain Ridge Cutting Across Sunset */}
        <img
          ref={homeTransitionBgRef}
          src="/images/transition-bg-2.avif"
          alt="Dark Silhouette Mountain Horizon"
          className="home-transition_bg-static"
        />
      </section>

      {/* 4. SECTION TRAVEL (PRIVATE & CORPORATE CARDS) */}
      <section className="section_travel" ref={travelSectionRef}>
        <div className="padding-global padding-0">
          <div className="container-max">
            <div className="travel_grid-wrapper">
              <div className="travel_grid">
                {/* Card 1: Solo Travel */}
                <div className="travel_grid-item">
                  <img
                    src="/images/solo_travel.jpeg"
                    alt="Solo Travel"
                    className="travel_grid-item-img"
                  />
                  <div className="travel_grid-item-bottom">
                    <a
                      href="/solo/packages"
                      className="button is-secondary is-blur"
                    >
                      <div>EXPLORE</div>
                      <div className="button-icon">
                        <svg
                          width="100%"
                          height="100%"
                          viewBox="0 0 16 16"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M13.5026 7.05623L7.05882 13.5L6 12.4412L12.4438 5.9974H6.76429V4.5H15V12.7357H13.5026V7.05623Z"
                            fill="white"
                          />
                        </svg>
                      </div>
                    </a>
                    <div className="travel_grid-item-bottom-line">
                      <h3>
                        Solo <br />
                        travel
                      </h3>
                      <div className="travel_grid-item-bottom-text">
                        Thoughtfully planned travel for individuals and
                        families. Every detail handled with care, discretion,
                        and flexibility.
                      </div>
                    </div>
                  </div>
                </div>

                {/* Card 2: Group Travel */}
                <div className="travel_grid-item">
                  <img
                    src="/images/group_travel.jpeg"
                    alt="Group Travel"
                    className="travel_grid-item-img"
                  />
                  <div className="travel_grid-item-bottom">
                    <a
                      href="/group/packages"
                      className="button is-secondary is-blur"
                    >
                      <div>EXPLORE</div>
                      <div className="button-icon">
                        <svg
                          width="100%"
                          height="100%"
                          viewBox="0 0 16 16"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path
                            d="M13.5026 7.05623L7.05882 13.5L6 12.4412L12.4438 5.9974H6.76429V4.5H15V12.7357H13.5026V7.05623Z"
                            fill="white"
                          />
                        </svg>
                      </div>
                    </a>
                    <div className="travel_grid-item-bottom-line">
                      <h3>
                        Group <br />
                        travel
                      </h3>
                      <div className="travel_grid-item-bottom-text">
                        Efficient, reliable travel management for businesses
                        and executives who need things done right.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Silhouette Transition Curve */}
        <img
          ref={travelBottomBgRef}
          src="/images/remove1-1.avif"
          alt=""
          className="travel_bottom-bg"
        />
      </section>

      {/* 5. SECTION JOURNEY ("HOW WE SUPPORT EVERY JOURNEY") */}
      <JourneySection sectionRef={journeySectionRef} />

      {/* 6. SECTION TESTIMONIALS ("TRUSTED BY TRAVELERS WHO RETURN") */}
      <TestimonialsSection />

      {/* 7. SECTION FOOTER */}
      <FooterSection />

      {/* 8. BOTTOM-LEFT PRIVACY BADGE (As seen in the screenshots) */}
      <div
        className="cookie_badge"
        title="Privacy Preferences"
        aria-label="Privacy"
      >
        <div className="cookie_badge_pill" />
      </div>
    </div>
  );
}
