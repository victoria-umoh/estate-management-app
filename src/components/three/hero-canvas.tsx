'use client';

import dynamic from 'next/dynamic';
import { Component, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { EstateStill } from './estate-still';

/**
 * The hero's 3D scene, and every reason not to render it.
 *
 * Three.js and React Three Fiber are several hundred kilobytes. `ssr: false`
 * plus a lazy import is the same trick the toaster uses: the code is fetched
 * only once this component decides it will actually draw something, so no other
 * route — least of all the gate scanner — pays for it.
 *
 * The scene is skipped, not paused, when the viewer prefers reduced motion,
 * when WebGL is unavailable, or when the scene throws. In all three cases the
 * still renders instead. A marketing page that is blank on a machine without a
 * GPU is worse than one that was never animated.
 */
const EstateScene = dynamic(() => import('./estate-scene'), { ssr: false, loading: () => null });

function hasWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * React Three Fiber runs its own reconciler, so a failure inside it surfaces as
 * a render error that would otherwise take the whole page's error boundary with
 * it. Catching here costs a still image instead of a broken landing page.
 */
class SceneBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function HeroCanvas({ className }: { className?: string }) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const decide = () => setAnimate(!motionQuery.matches && hasWebGl());
    decide();

    // Someone who turns reduced motion on mid-visit means it, so honour it
    // immediately rather than waiting for a navigation.
    motionQuery.addEventListener('change', decide);
    return () => motionQuery.removeEventListener('change', decide);
  }, []);

  return (
    <div
      // Decorative: the hero's meaning is entirely in the adjacent copy, and a
      // screen reader has nothing to gain from a canvas. Nothing inside is
      // focusable, so focus order is untouched.
      aria-hidden
      className={cn('pointer-events-none relative isolate', className)}
    >
      {animate ? (
        <SceneBoundary fallback={<EstateStill />}>
          <EstateScene />
        </SceneBoundary>
      ) : (
        <EstateStill />
      )}
    </div>
  );
}
