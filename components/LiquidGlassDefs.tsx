/**
 * The shared SVG filter behind the "Liquid Glass" panel treatment.
 *
 * Glass panels refract what is behind them like a water droplet, with a faint
 * chromatic fringe at the edges: fractal noise is smoothed, then used to
 * displace the backdrop three times at slightly different scales — one per
 * colour channel, isolated with `feColorMatrix` and recombined with a screen
 * blend. The *spread* between the channel scales is what produces the rainbow
 * edge; the shared magnitude is the apparent thickness of the glass.
 *
 * The handoff's own defaults (refraction 55) visibly warp text sitting behind a
 * panel, which is why its screenshots look distorted. The values here are
 * deliberately gentler — enough to read as refracting glass at panel edges,
 * not enough to bend legible content. All of it is tunable from one place:
 * REFRACTION is the base scale, DISPERSION the per-channel spread.
 */

const REFRACTION = 14;
const DISPERSION = 3;

export function LiquidGlassDefs() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        <filter id="liquid-glass" x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.0084 0.0126"
            numOctaves={1}
            seed={7}
            result="noiseRaw"
          />
          <feGaussianBlur in="noiseRaw" stdDeviation="1.7" result="noise" />

          {/* Red channel — displaced furthest. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={REFRACTION + DISPERSION}
            xChannelSelector="R"
            yChannelSelector="G"
            result="dispR"
          />
          <feColorMatrix
            in="dispR"
            type="matrix"
            values="1 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="chR"
          />

          {/* Green channel — the base scale. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={REFRACTION}
            xChannelSelector="R"
            yChannelSelector="G"
            result="dispG"
          />
          <feColorMatrix
            in="dispG"
            type="matrix"
            values="0 0 0 0 0
                    0 1 0 0 0
                    0 0 0 0 0
                    0 0 0 1 0"
            result="chG"
          />

          {/* Blue channel — displaced least. */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={REFRACTION - DISPERSION}
            xChannelSelector="R"
            yChannelSelector="G"
            result="dispB"
          />
          <feColorMatrix
            in="dispB"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 1 0 0
                    0 0 0 1 0"
            result="chB"
          />

          <feBlend in="chR" in2="chG" mode="screen" result="chRG" />
          <feBlend in="chRG" in2="chB" mode="screen" />
        </filter>
      </defs>
    </svg>
  );
}
