import { cn } from '@/lib/utils';

/**
 * The hero image for anyone who will not get the 3D scene.
 *
 * Drawn in SVG with `currentColor` and token-driven classes rather than an
 * exported bitmap, so it stays sharp, weighs nothing, and follows the theme —
 * a rasterised light-mode render would look broken in dark mode.
 */
export function EstateStill({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 200"
      role="presentation"
      className={cn('h-full w-full', className)}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Grounds */}
      <rect x="18" y="26" width="284" height="148" rx="10" className="fill-muted" />

      {/* Perimeter wall, broken at the gate */}
      <g className="stroke-border" strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M28 168 H140" />
        <path d="M180 168 H292" />
        <path d="M28 36 H292" />
        <path d="M28 36 V168" />
        <path d="M292 36 V168" />
      </g>

      {/* Approach road */}
      <path d="M150 168 V60" className="stroke-border" strokeWidth="14" strokeLinecap="square" />

      {/* Houses */}
      {/* Two blocks either side of the approach road, spaced so no roof
          overlaps the house behind it. */}
      {[
        [44, 56],
        [86, 56],
        [44, 100],
        [86, 100],
        [196, 56],
        [238, 56],
        [196, 100],
        [238, 100],
      ].map(([x = 0, y = 0]) => (
        <g key={`${x}:${y}`}>
          <rect x={x} y={y + 12} width="28" height="24" rx="2" className="fill-background" />
          <path d={`M${x - 4} ${y + 12} L${x + 14} ${y - 1} L${x + 32} ${y + 12} Z`} className="fill-primary" />
        </g>
      ))}

      {/* Gatehouse and raised boom */}
      <rect x="168" y="146" width="26" height="24" rx="3" className="fill-background stroke-border" strokeWidth="2" />
      <circle cx="160" cy="152" r="5" className="fill-success" />
      <path d="M140 168 L140 138" className="stroke-warning" strokeWidth="5" strokeLinecap="round" />
      <circle cx="140" cy="170" r="4" className="fill-foreground" />
    </svg>
  );
}
