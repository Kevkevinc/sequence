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

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.5l3.5 2" />
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

export const IconMute = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 22 20H2z" />
    <path d="M12 9.5v4.5" />
    <circle cx="12" cy="17" r="0.6" fill="currentColor" />
  </Svg>
);

export const IconError = (p: IconProps) => (
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
    <path d="M9 6.5v11l9-5.5z" fill="currentColor" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
