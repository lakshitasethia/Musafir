"use client";

import React, { useEffect, useRef } from "react";

interface Story {
  who: string;
  where: string;
  text: string;
  image: string;
}

// Illustrative stories written for the demo, one per traveller type. They
// describe what Musafir actually does; swap in real reviews once they exist.
const stories: Story[] = [
  {
    who: "Solo rider",
    where: "Himalayas",
    text: "A landslide shut the pass on day three. Before I'd even pulled over, the day was re-planned around a valley road and a new place to sleep.",
    image: "/images/testimonial-solo-rider.jpg",
  },
  {
    who: "Four friends",
    where: "Jaipur",
    text: "We dragged the pacing fader all the way to café loiterer and it listened. Fewer forts, longer chai, and not one argument about the plan.",
    image: "/images/testimonial-friends.jpg",
  },
  {
    who: "Family of five",
    where: "Goa",
    text: "When our flight landed three hours late, the kids' beach afternoon was quietly moved to the next morning. One tap from me, that was it.",
    image: "/images/testimonial-family.jpg",
  },
  {
    who: "A couple",
    where: "Varanasi",
    text: "Rain was forecast for our evening boat ride. Musafir swapped it with the morning aarti, and we still caught the sunset on the ghats.",
    image: "/images/testimonial-couple.jpg",
  },
];

// Scrubbed like flyward.com/about: while the scene is pinned, scroll draws the
// route from the screen's left edge; each photo appears once the line reaches
// it, and the route runs on to the right edge after the last one.
const PIN_QUERY = "(min-width: 992px)";

type Pt = { x: number; y: number };

// Smooth curve through every point (Catmull-Rom as cubic Béziers).
function smoothPath(pts: Pt[]): string {
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += `C${c1.x.toFixed(1)} ${c1.y.toFixed(1)} ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

interface TestimonialsSectionProps {
  sectionRef?: React.RefObject<HTMLDivElement | null>;
}

export function TestimonialsSection({ sectionRef }: TestimonialsSectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const storiesRef = useRef<HTMLDivElement>(null);
  const routeRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    const scrollZone = scrollRef.current;
    const sticky = stickyRef.current;
    const storiesEl = storiesRef.current;
    const route = routeRef.current;
    if (!scrollZone || !sticky || !storiesEl || !route) return;

    const pinQuery = window.matchMedia(PIN_QUERY);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cards = Array.from(storiesEl.querySelectorAll<HTMLElement>(".story"));
    let thresholds: number[] = [];
    let frame = 0;

    // Build the route edge to edge through the photos, in the pinned scene's
    // own pixels, and note where along it (0..1) the line reaches each photo.
    const measure = () => {
      // Pin from the top when the scene fits, else pin once its bottom arrives.
      sticky.style.top = `${Math.min(0, window.innerHeight - sticky.offsetHeight)}px`;

      const svg = route.ownerSVGElement;
      const box = sticky.getBoundingClientRect();
      if (!svg || box.width === 0) return;
      svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);

      const frames = cards.map((card) => {
        const r = card.querySelector(".story_image")!.getBoundingClientRect();
        const lift = new DOMMatrix(getComputedStyle(card).transform).m42; // undo reveal offset
        return { l: r.left - box.left, r: r.right - box.left, t: r.top - box.top - lift, b: r.bottom - box.top - lift };
      });
      if (frames.length === 0) return;
      const h = frames[0].b - frames[0].t;
      const centres = frames.map((f) => ({ x: (f.l + f.r) / 2, y: (f.t + f.b) / 2 }));
      const first = frames[0];
      const last = frames[frames.length - 1];

      // Loops between photos alternate high and low, staying inside the photo
      // band so the line never crosses the text beneath.
      const pts: Pt[] = [
        { x: 0, y: centres[0].y - h * 0.3 },
        { x: first.l * 0.55, y: centres[0].y + h * 0.28 },
      ];
      centres.forEach((c, i) => {
        pts.push(c);
        const next = frames[i + 1];
        if (!next) return;
        const a = frames[i];
        const x = (a.r + next.l) / 2;
        const y = i % 2 === 0 ? Math.min(a.t, next.t) + h * 0.1 : Math.min(a.b, next.b) - h * 0.1;
        pts.push({ x, y });
      });
      pts.push({ x: (last.r + box.width) / 2, y: centres[centres.length - 1].y - h * 0.35 });
      pts.push({ x: box.width, y: centres[centres.length - 1].y + h * 0.05 });
      route.setAttribute("d", smoothPath(pts));

      // A photo appears once the line has reached its centre.
      const total = route.getTotalLength();
      const samples = Array.from({ length: 401 }, (_, i) => {
        const at = (i / 400) * total;
        return { t: i / 400, p: route.getPointAtLength(at) };
      });
      thresholds = centres.map((c) =>
        samples.reduce((best, s) =>
          Math.hypot(s.p.x - c.x, s.p.y - c.y) < Math.hypot(best.p.x - c.x, best.p.y - c.y) ? s : best
        ).t
      );
    };

    const update = () => {
      frame = 0;
      const animate = pinQuery.matches && !reduceMotion.matches;
      storiesEl.classList.toggle("is-armed", animate);
      if (!animate) {
        route.style.strokeDashoffset = "0";
        cards.forEach((card) => card.classList.add("is-in"));
        return;
      }
      const zone = scrollZone.getBoundingClientRect();
      const pinTop = parseFloat(sticky.style.top) || 0;
      const distance = zone.height - sticky.offsetHeight;
      const progress = distance > 0 ? Math.min(Math.max((pinTop - zone.top) / distance, 0), 1) : 1;
      route.style.strokeDashoffset = `${1 - progress}`;
      cards.forEach((card, i) => card.classList.toggle("is-in", progress >= thresholds[i]));
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const remeasure = () => {
      measure();
      schedule();
    };

    remeasure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", remeasure);
    pinQuery.addEventListener("change", remeasure);
    // Photos, fonts and the viewport all move the cards; rebuild the route
    // whenever the scene's size changes.
    const resizeObserver = new ResizeObserver(remeasure);
    resizeObserver.observe(sticky);
    storiesEl.querySelectorAll(".story_image").forEach((img) => resizeObserver.observe(img));
    document.fonts?.ready.then(remeasure);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      pinQuery.removeEventListener("change", remeasure);
    };
  }, []);

  return (
    <div className="section_testimonials" ref={sectionRef}>
      {/* Top transition - continuous torn paper edge from journey section */}
      <div className="testimonials_transition-top-wrp">
        <img
          src="/images/torn-edge-down.avif"
          alt=""
          className="testimonials_transition-top"
        />
      </div>

      {/* Pinned scene: heading, route and stories stay put while it plays */}
      <div className="stories_scroll" ref={scrollRef}>
        <div className="stories_sticky" ref={stickyRef}>
          {/* full-width route, built in JS from the photos' positions */}
          <svg className="stories_route" aria-hidden="true">
            <defs>
              <linearGradient id="stories-route-gradient" x1="0" y1="0" x2="1" y2="0">
                {/* the journey route's dusk tones, deepened to read on the lilac sky */}
                <stop offset="0" stopColor="#9585ad" />
                <stop offset="0.5" stopColor="#b08fae" />
                <stop offset="1" stopColor="#c8937e" />
              </linearGradient>
            </defs>
            <path ref={routeRef} pathLength={1} />
          </svg>

          <div className="padding-global stories_content">
            <div className="container-max">
              <h2 className="heading-style-h2 text-align-center">
                Testimonials by our
                <br />
                Musafirs
              </h2>

              <div className="stories" ref={storiesRef}>
                <ol className="stories_list">
                  {stories.map((story, i) => (
                    <li key={story.who} className="story">
                      <figure className="story_frame">
                        <img
                          src={story.image}
                          alt={`${story.who} in ${story.where}`}
                          className="story_image"
                          loading="lazy"
                        />
                        <span className="story_num">{i + 1}</span>
                      </figure>
                      <div className="story_who">{story.who}</div>
                      <div className="story_where">{story.where}</div>
                      <p className="story_text">&ldquo;{story.text}&rdquo;</p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </div>
        {/* scroll distance the scene stays pinned for */}
        <div className="stories_spacer" aria-hidden="true" />
      </div>

      <div className="stories_tail padding-global">
        <p className="stories_note">
          Illustrative stories showing how Musafir handles a trip on the road.
        </p>
      </div>

      {/* Background scenic image */}
      <img
        src="/images/testimonials-bg.avif"
        alt=""
        className="testimonials_bg-img"
      />

      {/* Bottom transition torn paper edge */}
      <div className="testimonials_transition-bottom-wrp">
        <img
          src="/images/remove4-1.avif"
          alt=""
          className="testimonials_transition-bottom"
        />
      </div>
    </div>
  );
}
