/**
 * Entrance animation and sticky positioning for a block.
 *
 * Kept small on purpose. Elementor's motion effects are a parallax engine —
 * mouse tracking, scroll-linked transforms, 3D tilt — and they exist to sell
 * agency websites. For a portal or a public-sector site the useful subset is
 * "fade this in when it comes into view" and "keep this bar at the top", so that
 * is the subset, and it is honest about being one.
 *
 * NO JAVASCRIPT IS REQUIRED for the effect to be correct. The animation is a CSS
 * class plus a delay variable; a block starts hidden only when the observer in
 * `BlockRenderer` is running, and the stylesheet's default state is VISIBLE. A
 * page whose script failed still shows all of its content — the opposite
 * arrangement is how an animation library turns into a blank page.
 *
 * `prefers-reduced-motion` is honoured in the stylesheet rather than here, so it
 * responds to the visitor changing the setting without a reload.
 */

// biome-ignore lint/suspicious/noExplicitAny: block payloads are untyped JSON
type Any = any;

export const MOTION_TYPES = ['none', 'fade', 'up', 'down', 'left', 'right', 'zoom'] as const;
export type MotionType = (typeof MOTION_TYPES)[number];

const CLASS: Record<string, string> = {
  fade: 'zv-anim zv-anim-fade',
  up: 'zv-anim zv-anim-up',
  down: 'zv-anim zv-anim-down',
  left: 'zv-anim zv-anim-left',
  right: 'zv-anim zv-anim-right',
  zoom: 'zv-anim zv-anim-zoom',
};

export interface MotionAttrs {
  class: string;
  style: string;
}

/**
 * The class and inline variables a block's motion settings produce.
 *
 * Values are clamped rather than trusted: a delay of 30 seconds, typed by
 * accident, is a block that never appears.
 */
export function motionAttrs(block: Any): MotionAttrs {
  const m = block?.motion;
  const classes: string[] = [];
  const style: string[] = [];

  if (m && typeof m === 'object') {
    const anim = CLASS[String(m.type ?? 'none')];
    if (anim) {
      classes.push(anim);
      const duration = clamp(Number(m.duration) || 500, 100, 3000);
      const delay = clamp(Number(m.delay) || 0, 0, 2000);
      style.push(`--zv-anim-dur:${duration}ms`, `--zv-anim-delay:${delay}ms`);
    }
    if (m.sticky === true) {
      classes.push('zv-sticky');
      style.push(`--zv-sticky-top:${clamp(Number(m.stickyOffset) || 0, 0, 400)}px`);
    }
  }

  return { class: classes.join(' '), style: style.join(';') };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
