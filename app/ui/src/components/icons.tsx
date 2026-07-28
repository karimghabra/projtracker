/**
 * Small inline SVG icon set (no icon package). All icons are 16x16 stroke
 * icons drawing currentColor, decorative by default (aria-hidden) — the
 * surrounding control carries the accessible name.
 */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function base(props: P) {
  const { size = 16, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...rest,
  };
}

export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 8.5 6 12l7.5-8" />
  </svg>
);

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2.5v11M2.5 8h11" />
  </svg>
);

export const IconTrash = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 4h11M6.5 4V2.8h3V4M4 4l.7 9.2h6.6L12 4M6.7 6.5v4.5M9.3 6.5v4.5" />
  </svg>
);

export const IconPencil = (p: P) => (
  <svg {...base(p)}>
    <path d="m9.7 3 3.3 3.3-7.2 7.2-3.7.4.4-3.7Z" />
    <path d="m8.4 4.3 3.3 3.3" />
  </svg>
);

export const IconCalendar = (p: P) => (
  <svg {...base(p)}>
    <rect x="2" y="3.2" width="12" height="10.8" rx="1.5" />
    <path d="M2 6.4h12M5.2 1.6v3.2M10.8 1.6v3.2" />
  </svg>
);

export const IconBell = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2a4 4 0 0 0-4 4v2.6L2.6 11h10.8L12 8.6V6a4 4 0 0 0-4-4Z" />
    <path d="M6.5 13.2a1.6 1.6 0 0 0 3 0" />
  </svg>
);

export const IconInbox = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 9.5 3.8 3h8.4L14 9.5V13H2Z" />
    <path d="M2 9.5h3.5a2.5 2.5 0 0 0 5 0H14" />
  </svg>
);

export const IconGraph = (p: P) => (
  <svg {...base(p)}>
    <circle cx="4" cy="4" r="1.8" />
    <circle cx="12" cy="5.5" r="1.8" />
    <circle cx="7" cy="12" r="1.8" />
    <path d="M5.6 4.6 10.3 5.3M4.8 5.7 6.3 10.4M10.7 6.9 8.2 10.8" />
  </svg>
);

export const IconSun = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.4v1.6M8 13v1.6M1.4 8H3M13 8h1.6M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" />
  </svg>
);

export const IconMoon = (p: P) => (
  <svg {...base(p)}>
    <path d="M13.4 9.4A5.6 5.6 0 0 1 6.6 2.6a5.6 5.6 0 1 0 6.8 6.8Z" />
  </svg>
);

export const IconImport = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 2v8M4.8 6.8 8 10l3.2-3.2M2.5 13.5h11" />
  </svg>
);

export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="7" cy="7" r="4.2" />
    <path d="m10.2 10.2 3.4 3.4" />
  </svg>
);

export const IconChevron = (p: P & { dir?: "right" | "down" | "up" | "left" }) => {
  const { dir = "right", ...rest } = p;
  const rotate = { right: 0, down: 90, left: 180, up: 270 }[dir];
  return (
    <svg {...base(rest)} style={{ transform: `rotate(${rotate}deg)`, ...rest.style }}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
};

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  </svg>
);

export const IconGrip = (p: P) => (
  <svg {...base(p)} stroke="none" fill="currentColor">
    <circle cx="6" cy="3.5" r="1.1" />
    <circle cx="10" cy="3.5" r="1.1" />
    <circle cx="6" cy="8" r="1.1" />
    <circle cx="10" cy="8" r="1.1" />
    <circle cx="6" cy="12.5" r="1.1" />
    <circle cx="10" cy="12.5" r="1.1" />
  </svg>
);

export const IconFolder = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.8h4.5A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z" />
  </svg>
);

export const IconBoard = (p: P) => (
  <svg {...base(p)}>
    <rect x="2" y="2" width="5.2" height="7" rx="1" />
    <rect x="8.8" y="2" width="5.2" height="4.5" rx="1" />
    <rect x="2" y="10.5" width="5.2" height="3.5" rx="1" />
    <rect x="8.8" y="8" width="5.2" height="6" rx="1" />
  </svg>
);

export const IconArrowUp = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 13V3M4.2 6.8 8 3l3.8 3.8" />
  </svg>
);

export const IconArrowDown = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 3v10M4.2 9.2 8 13l3.8-3.8" />
  </svg>
);
