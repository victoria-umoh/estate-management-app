'use client';

import { motion, useReducedMotion, type HTMLMotionProps, type Variants } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Shared motion.
 *
 * Durations are short on purpose. This is an operations tool: a security
 * officer works the gate screen hundreds of times a shift, and animation that
 * feels elegant on the first pass is an obstruction by the fiftieth. Motion
 * here confirms that something changed; it never gates the change itself.
 *
 * Every primitive collapses to an instant transition under
 * `prefers-reduced-motion`, rather than merely running faster.
 */

export const EASE_OUT = [0.25, 1, 0.5, 1] as const;
export const EASE_SPRING = [0.34, 1.56, 0.64, 1] as const;

export const DURATION = {
  instant: 0.1,
  fast: 0.16,
  base: 0.24,
  slow: 0.4,
} as const;

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: DURATION.base, ease: EASE_OUT } },
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION.base, ease: EASE_OUT } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: { duration: DURATION.fast, ease: EASE_OUT } },
};

/** Stagger for lists. Kept tight so a long list does not crawl into view. */
export const staggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

export interface RevealProps extends HTMLMotionProps<'div'> {
  children: ReactNode;
  /**
   * Animate once when scrolled into view, rather than on mount.
   *
   * Named `whenInView` rather than `onScroll`, which would collide with the DOM
   * scroll handler that div already accepts.
   */
  whenInView?: boolean;
  variant?: Variants;
}

/**
 * Reveal a block on mount or on scroll.
 *
 * Renders a plain div when reduced motion is requested, so no animation
 * machinery runs at all.
 */
export function Reveal({ children, whenInView, variant = fadeUp, ...props }: RevealProps) {
  const reduced = useReducedMotion();

  if (reduced) return <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;

  return (
    <motion.div
      initial="hidden"
      {...(whenInView
        ? { whileInView: 'visible', viewport: { once: true, margin: '-60px' } }
        : { animate: 'visible' })}
      variants={variant}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Stagger a list of children into view. */
export function StaggerList({
  children,
  ...props
}: HTMLMotionProps<'div'> & { children: ReactNode }) {
  const reduced = useReducedMotion();

  if (reduced) return <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;

  return (
    <motion.div initial="hidden" animate="visible" variants={staggerContainer} {...props}>
      {children}
    </motion.div>
  );
}

export function StaggerItem({
  children,
  ...props
}: HTMLMotionProps<'div'> & { children: ReactNode }) {
  const reduced = useReducedMotion();

  if (reduced) return <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div>;

  return (
    <motion.div variants={fadeUp} {...props}>
      {children}
    </motion.div>
  );
}

export { motion, useReducedMotion };
