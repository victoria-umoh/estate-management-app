'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * Lazy wrapper for Three.js scenes.
 *
 * Three.js and React Three Fiber together are several hundred kilobytes. They
 * are loaded only when a scene is actually going to render, and only on
 * surfaces that have earned it: marketing, the digital ID card, and the estate
 * map. The gate route group never mounts this, so it never pays for it.
 *
 * A scene is skipped entirely — not merely paused — when:
 *  - the viewer prefers reduced motion,
 *  - the canvas is off-screen,
 *  - WebGL is unavailable,
 *  - or 3D is disabled by feature flag.
 *
 * In each case the `fallback` renders instead, so the page is complete without
 * the scene rather than degraded by its absence.
 */
const Canvas = dynamic(() => import('@react-three/fiber').then((module) => module.Canvas), {
  ssr: false,
  loading: () => null,
});

function hasWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

export interface SceneProps {
  children: ReactNode;
  /** Shown whenever the scene is skipped. Should stand on its own. */
  fallback?: ReactNode;
  className?: string;
  /** Disable via feature flag, passed from a server component. */
  enabled?: boolean;
  cameraPosition?: [number, number, number];
}

export function Scene({
  children,
  fallback = null,
  className,
  enabled = true,
  cameraPosition = [0, 0, 5],
}: SceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const [visible, setVisible] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    setSupported(hasWebGl());
  }, []);

  // Only mount once the container is actually on screen: a hero below the fold
  // should not cost a WebGL context before anyone scrolls to it.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '150px' },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shouldRender = enabled && !reducedMotion && supported === true && visible;

  return (
    <div ref={containerRef} className={cn('relative', className)} aria-hidden={shouldRender}>
      {shouldRender ? (
        <Canvas
          camera={{ position: cameraPosition, fov: 45 }}
          // Capped so a high-DPI phone does not render four times the pixels it
          // needs and drain the battery for a decorative background.
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        >
          {children}
        </Canvas>
      ) : (
        fallback
      )}
    </div>
  );
}
