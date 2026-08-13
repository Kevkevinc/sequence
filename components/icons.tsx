/**
 * Inline 2px-stroke icons, sized by the `size` prop and coloured by
 * `currentColor` so they inherit whatever text colour they sit in.
 */

type IconProps = { size?: number };

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </Svg>
);

export const IconVideos = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="M10 9.5v5l4-2.5z" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 18 5-5 4 3.5 3-2.5 4 4" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V13" />
    <circle cx="12" cy="16.4" r="0.6" fill="currentColor" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <circle cx="12" cy="7.8" r="0.6" fill="currentColor" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6.5v11l9-5.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9" />
    <path d="M10.5 18a1.8 1.8 0 0 0 3 0" />
  </Svg>
);

/**
 * The Sequence mark: four blades closing on a centre, which is what the editor
 * does to a clip. Drawn as filled shapes rather than strokes so it holds its
 * weight at 30px, where a 2px stroke would read as a scratch.
 */
export const LogoMark = ({ size = 30 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 30 30"
    fill="none"
    aria-hidden="true"
    focusable="false"
    style={{ flexShrink: 0 }}
  >
    <path
      d="M15 1c2.2 3.1 3.3 6 3.3 9.2 0 .6-.1 1.2-.2 1.7 .5-.1 1.1-.2 1.7-.2 3.2 0 6.1 1.1 9.2 3.3-3.1 2.2-6 3.3-9.2 3.3-.6 0-1.2-.1-1.7-.2 .1.5.2 1.1.2 1.7 0 3.2-1.1 6.1-3.3 9.2-2.2-3.1-3.3-6-3.3-9.2 0-.6.1-1.2.2-1.7-.5.1-1.1.2-1.7.2-3.2 0-6.1-1.1-9.2-3.3 3.1-2.2 6-3.3 9.2-3.3 .6 0 1.2.1 1.7.2-.1-.5-.2-1.1-.2-1.7C11.7 7 12.8 4.1 15 1z"
      fill="#fff"
    />
    <circle cx="15" cy="15" r="2.4" fill="#0c0c0c" />
  </svg>
);

