"use client";

import React, { useEffect, useRef, useState } from "react";
import Lenis from "lenis";
import { HeroMask } from "./components/HeroMask";
import { GridSvg } from "./components/GridSvg";
import { StarSvg } from "./components/StarSvg";
import { LogoSvg } from "./components/LogoSvg";

export default function FlywardHero() {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomImgRef = useRef<HTMLImageElement>(null);
  const topImgRef = useRef<HTMLImageElement>(null);
  const maskInnerRef = useRef<HTMLDivElement>(null);
  const topTextRef = useRef<HTMLDivElement>(null);
  const [navDark, setNavDark] = useState(false);

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
      // Normalized between -1 and 1
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
      // Progress over first 100vh
      const scrollProgress = Math.min(Math.max(scrollY / viewportHeight, 0), 1);

      // Webflow Action a-8: mask width expands from 100vw to 750vw
      const maskWidth = 100 + scrollProgress * 650; // 100vw -> 750vw
      // Background scales from 1.2 to 1.0
      const bgScale = 1.2 - scrollProgress * 0.2;

      // Apply to mask inner
      if (maskInnerRef.current) {
        maskInnerRef.current.style.width = `${maskWidth}vw`;
      }

      // Parallax values for .is-bottom: X: -3rem to +3rem, Y: -3.5rem to +3.5rem
      if (bottomImgRef.current) {
        const moveX = mx * 35; // pixels
        const moveY = my * 40;
        bottomImgRef.current.style.transform = `scale(${bgScale}) translate3d(${moveX}px, ${moveY}px, 0)`;
      }

      // Parallax values for .is-top: rotateY: -1deg to +1deg, rotateX: 2deg to -2deg
      if (topImgRef.current) {
        const rotY = mx * 1.2;
        const rotX = -my * 2.0;
        topImgRef.current.style.transform = `scale(${bgScale}) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
      }

      // Fade top hero text out as mask zooms
      if (topTextRef.current) {
        const textOpacity = Math.max(1 - scrollProgress * 1.5, 0);
        topTextRef.current.style.opacity = `${textOpacity}`;
      }

      // Switch navbar contrast based on scroll
      if (scrollProgress > 0.4) {
        setNavDark(true);
      } else {
        setNavDark(false);
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

  return (
    <div className="page-wrapper">
      {/* 1. TOP NAVIGATION */}
      <header
        className="nav_component"
        style={{
          color: navDark ? "#ffffff" : "#3d2d20",
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
                href="#contact"
                className="button is-secondary is-nav"
                style={{
                  borderColor: navDark ? "#ffffff" : "#3d2d20",
                  color: navDark ? "#ffffff" : "#3d2d20",
                }}
              >
                CONTACT
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* 2. HERO SECTION */}
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
            {/* Phase 1: Center Cutout Typography */}
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

            {/* Phase 2: Full Screen Revealed Narrative */}
            <div id="discover" className="hero_scrollable-bottom">
              <h2 className="heading-style-h1">
                We make complex travel simple
              </h2>
              <div className="hero_scrollable-bottom-text">
                <div>
                  We don’t just arrange flights and hotels.
                  <br />
                  <br />
                  We manage the entire journey — before, during, and after travel —
                  anticipating needs, resolving issues proactively, and ensuring
                  every trip runs smoothly.
                  <br />
                  <br />
                  From frequent business travel to once-in-a-lifetime journeys,
                  Flyward operates as an extension of your world.
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* 3. BOTTOM-LEFT PRIVACY BADGE (As seen in the screenshot) */}
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
