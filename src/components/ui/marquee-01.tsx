import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Marquee } from "@/components/ui/marquee-01-utils/marquee";
import { cn } from "@/lib/utils";

const reviews = [
  {
    name: "Ken Masters",
    username: "@kmasters",
    body: "“Our productivity has nearly doubled since onboarding. Automation features removed repetitive tasks, allowing our team to focus on building instead of managing operations.”",
    profile: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=80&h=80&q=75",
  },
  {
    name: "Kira Athrun",
    username: "@kathrun",
    body: "“What surprised us most was how quickly our team adapted. Minimal learning curve, excellent documentation, and powerful features make it a must-have for modern SaaS companies.”",
    profile: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=80&h=80&q=75",
  },
  {
    name: "Lirael Nassun",
    username: "@lnassun",
    body: "“This is easily one of the most reliable SaaS tools we’ve adopted. The UI is intuitive, integrations are seamless, and it saves us countless hours every week.”",
    profile: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=80&h=80&q=75",
  },
  {
    name: "Jessica",
    username: "@jessica",
    body: "Switching to this platform streamlined our entire workflow. Setup was effortless, performance improved instantly, and our team now ships features faster without worrying about infrastructure.",
    profile: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=80&h=80&q=75",
  },
  {
    name: "Jenny",
    username: "@jenny",
    body: "“We evaluated multiple solutions, but this stood out immediately. It’s fast, scalable, and thoughtfully designed for growing teams that need stability without added complexity.”",
    profile: "https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=80&h=80&q=75",
  },
  {
    name: "Kira Athrun",
    username: "@kathrun",
    body: "“What surprised us most was how quickly our team adapted. Minimal learning curve, excellent documentation, and powerful features make it a must-have for modern SaaS companies.”",
    profile: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=80&h=80&q=75",
  },
  {
    name: "Ken Masters",
    username: "@kmasters",
    body: "“Our productivity has nearly doubled since onboarding. Automation features removed repetitive tasks, allowing our team to focus on building instead of managing operations.”",
    profile: "https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&w=80&h=80&q=75",
  },
];

const firstRow = reviews.slice(0, Math.ceil(reviews.length / 2));
const secondRow = reviews.slice(Math.ceil(reviews.length / 2));

const ReviewCard = ({
  profile,
  name,
  username,
  body,
}: {
  profile: string;
  name: string;
  username: string;
  body: string;
}) => {
  return (
    <Card className="relative h-full w-64 sm:w-72 cursor-pointer overflow-hidden border-border bg-card shadow-sm hover:shadow-md hover:border-gray-300 transition-all p-4 select-none">
      <CardContent className="p-0 flex flex-col gap-2">
        <div className="flex flex-row items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="rounded-full object-cover w-8 h-8 ring-1 ring-gray-200"
            width="32"
            height="32"
            alt={name}
            src={profile}
          />
          <div className="flex flex-col min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">{name}</p>
            <p className="text-xs font-normal text-muted-foreground truncate">
              {username}
            </p>
          </div>
        </div>
        <p className="text-xs sm:text-sm line-clamp-2 text-foreground/90 leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
};

export function TestimonialMarqueeDemo({ className }: { className?: string } = {}) {
  return (
    <div className={cn("relative flex w-full flex-col items-center justify-center overflow-hidden gap-3 sm:gap-4 py-2", className)}>
      <Marquee pauseOnHover className="[--duration:24s]">
        {firstRow.map((review, idx) => (
          <ReviewCard key={`first-${review.username}-${idx}`} {...review} />
        ))}
      </Marquee>
      <Marquee reverse pauseOnHover className="[--duration:24s]">
        {secondRow.map((review, idx) => (
          <ReviewCard key={`second-${review.username}-${idx}`} {...review} />
        ))}
      </Marquee>
      <div className="from-background to-transparent pointer-events-none absolute inset-y-0 left-0 w-16 sm:w-1/4 bg-gradient-to-r z-10" />
      <div className="from-background to-transparent pointer-events-none absolute inset-y-0 right-0 w-16 sm:w-1/4 bg-gradient-to-l z-10" />
    </div>
  );
}

export { TestimonialMarqueeDemo as TestimonialMarquee };
export default TestimonialMarqueeDemo;
