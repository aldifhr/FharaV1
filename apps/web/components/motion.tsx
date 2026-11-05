"use client";
import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

export const EASE = [0.22, 1, 0.36, 1] as const;

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE } },
};
export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.2, ease: "easeOut" } },
};
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.95, y: 6 },
  show: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 28 } },
};
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
};
export const slideRight: Variants = {
  hidden: { opacity: 0, x: 20 },
  show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: "easeOut" } },
};
export const slideLeft: Variants = {
  hidden: { opacity: 0, x: -20 },
  show: { opacity: 1, x: 0, transition: { duration: 0.2, ease: "easeOut" } },
};

export const itemProps = { variants: fadeUp, initial: "hidden", animate: "show" } as const;
export const listProps = { variants: stagger, initial: "hidden", animate: "show" } as const;

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: EASE }}>
      {children}
    </motion.div>
  );
}

export { motion, AnimatePresence, LayoutGroup, MotionConfig, useReducedMotion } from "framer-motion";
export { useScroll, useSpring, useMotionValue, useTransform, useAnimation, useInView, useTime } from "framer-motion";
