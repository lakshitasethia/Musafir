"use client";

import React, { useRef, useState } from "react";

interface Testimonial {
  name: string;
  title: string;
  text: string;
  image: string;
}

const testimonials: Testimonial[] = [
  {
    name: "Kenneth Mackinnon",
    title: "Top Notch!",
    text: "I originally thought using an agent would be more expensive, but Flyward actually saved me money. Their relationships with airlines and hotels meant I got a what I wanted for a better price. They are masters at optimizing a budget.",
    image: "/images/testimonial1.jpeg",
  },
  {
    name: "Amir Elayyan",
    title: "Great Experience!",
    text: "Planning a holiday to Madagascar was something I always thought would be a logistical nightmare, until I called Flyward. They handled everything: research, planning, bookings, even payments, then simply sent me the final itinerary and invoice. I was speechless. It felt like a close family member had taken care of it all, anticipating every detail before I even asked. This is more than service, it's trust and warmth, wrapped into one incredible team.",
    image: "/images/testimonial2.jpeg",
  },
];

interface TestimonialsSectionProps {
  sectionRef?: React.RefObject<HTMLDivElement | null>;
}

export function TestimonialsSection({ sectionRef }: TestimonialsSectionProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const slideRef = useRef<HTMLDivElement>(null);

  const goToPrev = () => {
    setCurrentSlide((prev) =>
      prev === 0 ? testimonials.length - 1 : prev - 1
    );
  };

  const goToNext = () => {
    setCurrentSlide((prev) =>
      prev === testimonials.length - 1 ? 0 : prev + 1
    );
  };

  const current = testimonials[currentSlide];

  return (
    <div className="section_testimonials" ref={sectionRef}>
      {/* Top transition - torn paper edge from journey section */}
      <div className="testimonials_transition-top-wrp">
        <img
          src="/images/num-fin.avif"
          alt=""
          className="testimonials_transition-top"
        />
      </div>

      <div className="padding-global padding-section-large padding-section-bottom-25">
        <div className="container-max">
          <h2 className="heading-style-h2 text-align-center">
            Trusted by travelers <br />
            who return
          </h2>

          <div className="testimonials_list-wrapper">
            {/* Testimonial slide */}
            <div className="testimonials_slide" ref={slideRef} key={currentSlide}>
              <img
                src={current.image}
                alt={current.name}
                className="testimonials_image"
              />
              <div className="testimonials_slide-heading">
                <div className="heading-style-h4">{current.name}</div>
                <div className="text-size-caption-medium">{current.title}</div>
              </div>
              <div className="text-size-large text-align-center">
                {current.text}
              </div>
            </div>

            {/* Navigation arrows */}
            <div className="swiper-button-left-wrp">
              <button
                aria-label="Previous slide"
                className="swiper-button is-prev"
                onClick={goToPrev}
              >
                <div className="swiper-button-icon">
                  <svg
                    width="100%"
                    height="100%"
                    viewBox="0 0 20 20"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M6.86616 11.1127L15.979 11.1127L15.979 9.61527L6.86615 9.61526L10.8822 5.59926L9.82333 4.54044L3.99981 10.364L9.82335 16.1875L10.8822 15.1287L6.86616 11.1127Z"
                      fill="currentColor"
                    />
                  </svg>
                </div>
              </button>
            </div>
            <div className="swiper-button-right-wrp">
              <button
                aria-label="Next slide"
                className="swiper-button is-next"
                onClick={goToNext}
              >
                <div className="swiper-button-icon">
                  <svg
                    width="100%"
                    height="100%"
                    viewBox="0 0 20 20"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M12.8614 11.1127L3.74851 11.1127L3.7485 9.61527L12.8614 9.61526L8.84538 5.59926L9.9042 4.54044L15.7277 10.364L9.90419 16.1875L8.84537 15.1287L12.8614 11.1127Z"
                      fill="currentColor"
                    />
                  </svg>
                </div>
              </button>
            </div>
          </div>
        </div>
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
