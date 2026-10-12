"use client";

import React from "react";
import { motion } from "motion/react";
import { TestimonialsColumn, Testimonial } from "@/components/ui/testimonials-columns-1";
import { MINI_REVIEWS } from "@/data/testimonials";

const FALLBACK_AVATARS = [
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&w=96&h=96&q=75",
];

// Map MINI_REVIEWS to Testimonial items with identical avatars from the Wall of Love
const mappedTestimonials: Testimonial[] = MINI_REVIEWS.map((review) => {
  const avatarUrl =
    FALLBACK_AVATARS[
      Math.abs(
        review.name.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
      ) % FALLBACK_AVATARS.length
    ];

  return {
    text: review.quote,
    image: avatarUrl,
    name: review.name,
    handle: review.handle,
    role: review.handle,
    stars: review.stars || 5,
  };
});

// Arrange the 4 columns matching the layout from the user's screenshot
// Column 1: Sarah Chen, Zoe Martinez, Marcus H., Victor H. ...
const col1 = [
  mappedTestimonials[0],
  mappedTestimonials[1],
  mappedTestimonials[2],
  mappedTestimonials[3],
  ...mappedTestimonials.slice(16, 20),
];

// Column 2: Alexis R., Jasmine K., Isabella W., Maya R. ...
const col2 = [
  mappedTestimonials[4],
  mappedTestimonials[5],
  mappedTestimonials[6],
  mappedTestimonials[7],
  ...mappedTestimonials.slice(20, 24),
];

// Column 3: Nina C., Nathan B., Brooke A., Mia R. ...
const col3 = [
  mappedTestimonials[8],
  mappedTestimonials[9],
  mappedTestimonials[10],
  mappedTestimonials[11],
  ...mappedTestimonials.slice(24, 28),
];

// Column 4: Ava T., Chloe B., Olivia W., Ryan D. ...
const col4 = [
  mappedTestimonials[12],
  mappedTestimonials[13],
  mappedTestimonials[14],
  mappedTestimonials[15],
  ...mappedTestimonials.slice(28, 30),
];

export const Testimonials = () => {
  return (
    <section className="py-16 sm:py-20 lg:py-24 relative overflow-hidden bg-white">
      <div className="max-w-[1320px] mx-auto px-4 sm:px-6">
        {/* Centered Heading */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          viewport={{ once: true }}
          className="text-center max-w-3xl mx-auto mb-10 sm:mb-14"
        >
          <h2 className="text-3xl font-semibold tracking-tight text-[#142033] sm:text-4xl lg:whitespace-nowrap">
            8,573 job seekers are using CareerMonke
          </h2>
        </motion.div>

        {/* 4 Moving Vertical Columns with Smooth Mask Fade */}
        <div className="flex justify-center gap-4 sm:gap-5 lg:gap-6 [mask-image:linear-gradient(to_bottom,transparent,black_15%,black_85%,transparent)] max-h-[720px] sm:max-h-[760px] overflow-hidden">
          {/* Column 1 - visible on all breakpoints */}
          <TestimonialsColumn testimonials={col1} duration={26} />

          {/* Column 2 - visible on sm and up */}
          <TestimonialsColumn
            testimonials={col2}
            className="hidden sm:block"
            duration={34}
          />

          {/* Column 3 - visible on lg and up */}
          <TestimonialsColumn
            testimonials={col3}
            className="hidden lg:block"
            duration={29}
          />

          {/* Column 4 - visible on xl and up */}
          <TestimonialsColumn
            testimonials={col4}
            className="hidden xl:block"
            duration={36}
          />
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
