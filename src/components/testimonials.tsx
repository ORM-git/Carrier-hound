"use client";

import React from "react";
import { motion } from "motion/react";
import { TestimonialsColumn, Testimonial } from "@/components/ui/testimonials-columns-1";
import { LANDING_CARDS } from "@/data/landingCards";

// Map LANDING_CARDS to Testimonial items
const mappedCards: Testimonial[] = LANDING_CARDS.map((card) => ({
  text: card.body,
  image: card.image,
  name: card.title,
  handle: card.tag,
  role: card.tag,
  stars: undefined,
}));

// Arrange the 4 columns matching the layout from the user's screenshot
// Column 1: cards 0, 1, 2
const col1 = [
  mappedCards[0],
  mappedCards[1],
  mappedCards[2],
];

// Column 2: cards 3, 4, 5
const col2 = [
  mappedCards[3],
  mappedCards[4],
  mappedCards[5],
];

// Column 3: cards 6, 7, 8
const col3 = [
  mappedCards[6],
  mappedCards[7],
  mappedCards[8],
];

// Column 4: cards 9, 10, 11
const col4 = [
  mappedCards[9],
  mappedCards[10],
  mappedCards[11],
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
            Why people join the waitlist
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
