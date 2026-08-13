/**
 * The grain over the gradient headline.
 *
 * Without it the sweeping line reads as flat vector colour, which is the one
 * thing that makes the brand element look cheap. Defined once here and
 * referenced by id from CSS, so the turbulence graph is not duplicated per
 * screen.
 *
 * Rendered into a zero-size <svg> that is hidden from assistive technology: it
 * draws nothing itself, it only supplies the filter.
 */
export function NoiseFilter() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <defs>
        <filter id="c3-noise" x="0%" y="0%" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves={2}
            result="grain"
          />
          <feColorMatrix
            in="grain"
            type="matrix"
            values="0 0 0 0 0.5
                    0 0 0 0 0.5
                    0 0 0 0 0.5
                    0 0 0 0.35 0"
            result="softGrain"
          />
          {/* Clipped to the glyphs, so grain never spills outside the text. */}
          <feComposite in="softGrain" in2="SourceGraphic" operator="in" result="clipped" />
          <feBlend in="SourceGraphic" in2="clipped" mode="multiply" />
        </filter>
      </defs>
    </svg>
  );
}
