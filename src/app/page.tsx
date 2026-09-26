"use client";

import React, { useEffect, useRef, useState } from "react";
import Lenis from "lenis";
import { HeroMask } from "./components/HeroMask";
import { GridSvg } from "./components/GridSvg";
import { StarSvg } from "./components/StarSvg";
import { LogoSvg } from "./components/LogoSvg";
import { TransitionGridSvg } from "./components/TransitionGridSvg";
import { JourneySection } from "./components/JourneySection";
import { TestimonialsSection } from "./components/TestimonialsSection";
import { FooterSection } from "./components/FooterSection";

export default function FlywardExperience() {
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

  // Mouse position state with smooth lerping for 2.5D Parallax
  const mouseRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0 });

  useEffect(() => {
    // 1. Initialize Lenis Smooth Scroll
    const lenis = new Lenis({
      lerp: 0.08,
      smoothWheel: true,
    });

    let animationFrameId: number;

    // 2. Mouse Move handler for 2.5D Parallax
    const handleMouseMove = (e: MouseEvent) => {
      const { innerWidth, innerHeight } = window;
      const normalizedX = (e.clientX / innerWidth) * 2 - 1;
      const normalizedY = (e.clientY / innerHeight) * 2 - 1;

      mouseRef.current.targetX = normalizedX;
      mouseRef.current.targetY = normalizedY;
    };

    window.addEventListener("mousemove", handleMouseMove);

    // 3. Scroll and Render loop
    const raf = (time: number) => {
      lenis.raf(time);

      // Smooth lerp mouse coordinates
      mouseRef.current.x += (mouseRef.current.targetX - mouseRef.current.x) * 0.05;
      mouseRef.current.y += (mouseRef.current.targetY - mouseRef.current.y) * 0.05;

      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      // Scroll progress computation
      const scrollY = window.scrollY || window.pageYOffset;
      const viewportHeight = window.innerHeight;

      // 1. Hero mask zoom progression (Webflow Action a-8: keyframe 0 to 33% of 200vh hero scroll = ~35vh)
      const heroScrollRange = viewportHeight; // The 100vh scrollable distance of the 200vh hero
      const maskProgress = Math.min(Math.max(scrollY / (heroScrollRange * 0.35), 0), 1);

      // Webflow Action a-8: mask width expands from 100vw to 750vw
      const maskWidth = 100 + maskProgress * 650; // 100vw -> 750vw
      const bgScale = 1.2 - maskProgress * 0.2; // 1.2 -> 1.0

      // Apply to mask inner
      if (maskInnerRef.current) {
        maskInnerRef.current.style.width = `${maskWidth}vw`;
        if (maskProgress >= 0.95) {
          maskInnerRef.current.style.opacity = "0";
          maskInnerRef.current.style.display = "none";
        } else if (maskProgress > 0.65) {
          maskInnerRef.current.style.display = "flex";
          maskInnerRef.current.style.opacity = `${1 - (maskProgress - 0.65) / 0.3}`;
        } else {
          maskInnerRef.current.style.display = "flex";
          maskInnerRef.current.style.opacity = "1";
        }
      }

      // Parallax values for .is-bottom: X: -3rem to +3rem, Y: -3.5rem to +3.5rem
      if (bottomImgRef.current) {
        const moveX = mx * 35;
        const moveY = my * 40;
        bottomImgRef.current.style.transform = `scale(${bgScale}) translate3d(${moveX}px, ${moveY}px, 0)`;
      }

      // Parallax values for .is-top: rotateY: -1deg to +1deg, rotateX: 2deg to -2deg
      if (topImgRef.current) {
        const rotY = mx * 1.2;
        const rotX = -my * 2.0;
        topImgRef.current.style.transform = `scale(${bgScale}) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
      }

      // Fade top hero text out quickly as mask zooms
      if (topTextRef.current) {
        const textOpacity = Math.max(1 - maskProgress * 1.8, 0);
        topTextRef.current.style.opacity = `${textOpacity}`;
        topTextRef.current.style.transform = `translate3d(0, ${-maskProgress * 40}px, 0)`;
      }

      // 2. Section Transition Parallax (Webflow Action a-18: 3rem -> -3rem)
      if (homeTransitionBgRef.current && homeTransitionSectionRef.current) {
        const rect = homeTransitionSectionRef.current.getBoundingClientRect();
        const transitionProgress = Math.min(
          Math.max((viewportHeight - rect.top) / (viewportHeight + rect.height), 0),
          1
        );
        const moveRem = 3 - transitionProgress * 6; // 3rem -> -3rem
        homeTransitionBgRef.current.style.transform = `translate3d(0, ${moveRem}rem, 0)`;
      }

      // 3. Travel bottom torn edge Parallax (Webflow Action a-19: 2rem -> 0rem)
      if (travelBottomBgRef.current && travelSectionRef.current) {
        const rect = travelSectionRef.current.getBoundingClientRect();
        const travelProgress = Math.min(
          Math.max((viewportHeight - rect.top) / (viewportHeight + rect.height), 0),
          1
        );
        const moveRem = 2 - travelProgress * 2; // 2rem -> 0rem
        travelBottomBgRef.current.style.transform = `translate3d(0, ${moveRem}rem, 0)`;
      }

      // 4. Dynamic Navbar Theme:
      // Initial hero top (before mask expands): light (dark text #3d2d20)
      // Over sunset, dark transition & travel cards: dark (white text #ffffff)
      // Over section_journey: light (dark text #3d2d20)
      if (journeySectionRef.current) {
        const journeyRect = journeySectionRef.current.getBoundingClientRect();
        if (journeyRect.top <= 60) {
          setNavTheme("light");
        } else if (scrollY > 120) {
          setNavTheme("dark");
        } else {
          setNavTheme("light");
        }
      } else {
        if (scrollY > 120) {
          setNavTheme("dark");
        } else {
          setNavTheme("light");
        }
      }

      animationFrameId = requestAnimationFrame(raf);
    };

    animationFrameId = requestAnimationFrame(raf);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(animationFrameId);
      lenis.destroy();
    };
  }, []);

  const isDarkNav = navTheme === "dark";

  return (
    <div className="page-wrapper">
      {/* 1. TOP NAVIGATION */}
      <header
        className="nav_component"
        style={{
          color: isDarkNav ? "#ffffff" : "#3d2d20",
        }}
      >
        <div className="padding-global">
          <div className="nav_container">
            {/* Left Nav Menu */}
            <nav className="nav_menu" role="navigation">
              <div className="nav_menu-content">
                <a href="#about" className="nav_menu_link">
                  ABOUT
                </a>
                <a href="#private" className="nav_menu_link">
                  PRIVATE
                </a>
                <a href="#corporate" className="nav_menu_link">
                  CORPORATE
                </a>
                <a href="#careers" className="nav_menu_link">
                  CAREERS
                </a>
              </div>
            </nav>

            {/* Center Brand Logo */}
            <a href="/" className="nav_brand" aria-label="Flyward Home">
              <div className="nav_logo">
                <LogoSvg />
              </div>
            </a>

            {/* Right Contact Button */}
            <div className="nav_contact-wrp">
              <a
                href="/login"
                className="button is-secondary is-nav"
                style={{
                  borderColor: isDarkNav ? "#ffffff" : "#3d2d20",
                  color: isDarkNav ? "#ffffff" : "#3d2d20",
                  marginRight: "0.5rem",
                }}
              >
                LOG IN
              </a>
              <a
                href="#contact"
                className="button is-secondary is-nav"
                style={{
                  borderColor: isDarkNav ? "#ffffff" : "#3d2d20",
                  color: isDarkNav ? "#ffffff" : "#3d2d20",
                }}
              >
                CONTACT
              </a>
            </div>
          </div>
        </div>
      </header>

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
                  alt="Flyward Horizon Sea View"
                  className="hero_bg-img is-bottom"
                />
                <img
                  ref={topImgRef}
                  src="/images/hero-top.avif"
                  alt="Flyward Horizon Traveler"
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
                  Flyward operates as an extension of your world.
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
                {/* Card 1: Private Travel */}
                <div className="travel_grid-item">
                  <img
                    src="/images/grid1.avif"
                    alt="Private Travel"
                    className="travel_grid-item-img"
                  />
                  <div className="travel_grid-item-bottom">
                    <a
                      href="#private"
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
                        Private <br />
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

                {/* Card 2: Corporate Travel */}
                <div className="travel_grid-item">
                  <img
                    src="/images/grid2.avif"
                    alt="Corporate Travel"
                    className="travel_grid-item-img"
                  />
                  <div className="travel_grid-item-bottom">
                    <a
                      href="#corporate"
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
                        Corporate <br />
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
