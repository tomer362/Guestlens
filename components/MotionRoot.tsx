"use client";
import { LazyMotion, domAnimation, MotionConfig } from "motion/react";

/** Loads only the DOM-animation feature set (~15 KB) and honours reduced-motion. */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
