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

// Route through the four photo centres (x 142 / 368 / 594 / 820, y 100 / 175
// alternating) in the 1000 x 300 band behind the cards. It loops in the gaps
// and stays above the text columns.
const ROUTE =
  "M0 70C50 40 100 60 142 100C190 150 230 30 265 50C300 70 320 160 368 175C420 190 450 60 500 50C545 42 565 80 594 100C640 130 690 215 745 200C785 185 790 160 820 175C880 205 930 80 1000 90";

// Scrubbed like flyward.com/about: while the scene is pinned, scroll draws the
// route, and each story fades up the moment the line reaches its photo.
const PIN_QUERY = "(min-width: 992px)";
const REVEAL_LEAD = 0.015; // show a card just before the line touches it

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

    // Where along the route (0..1) the line reaches each photo's left edge.
    const measure = () => {
      const svg = route.ownerSVGElement;
      if (!svg) return;
      const box = svg.getBoundingClientRect();
      const total = route.getTotalLength();
      const samples = Array.from({ length: 241 }, (_, i) => {
        const at = (i / 240) * total;
        return { t: at / total, x: route.getPointAtLength(at).x };
      });
      thresholds = cards.map((card) => {
        const img = card.querySelector(".story_image");
        if (!img || box.width === 0) return 0;
        const left = ((img.getBoundingClientRect().left - box.left) / box.width) * 1000;
        return samples.find((s) => s.x >= left)?.t ?? 1;
      });
      // Pin from the top when the scene fits, else pin once its bottom arrives.
      sticky.style.top = `${Math.min(0, window.innerHeight - sticky.offsetHeight)}px`;
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
      cards.forEach((card, i) => card.classList.toggle("is-in", progress + REVEAL_LEAD >= thresholds[i]));
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
    // photos are lazy; re-measure once they have their size
    storiesEl.querySelectorAll("img").forEach((img) => img.addEventListener("load", remeasure));

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      pinQuery.removeEventListener("change", remeasure);
      storiesEl.querySelectorAll("img").forEach((img) => img.removeEventListener("load", remeasure));
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
          <div className="padding-global">
            <div className="container-max">
              <h2 className="heading-style-h2 text-align-center">
                Testimonials by our
                <br />
                Musafirs
              </h2>

              <div className="stories" ref={storiesRef}>
                <svg
                  className="stories_route"
                  viewBox="0 0 1000 300"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="stories-route-gradient" x1="0" y1="0" x2="1000" y2="0" gradientUnits="userSpaceOnUse">
                      {/* the journey route's dusk tones, deepened to read on the lilac sky */}
                      <stop offset="0" stopColor="#9585ad" />
                      <stop offset="0.5" stopColor="#b08fae" />
                      <stop offset="1" stopColor="#c8937e" />
                    </linearGradient>
                  </defs>
                  <path ref={routeRef} d={ROUTE} pathLength={1} />
                </svg>

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
                      <p className="story_text">{story.text}</p>
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
