/**
 * Icons, inline.
 *
 * A published build must not fetch anything, so there is no icon font and no
 * sprite sheet. These are drawn on a 24-unit grid with a 1.7 stroke, which is
 * what keeps them looking like one set rather than a collection.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, viewBox = '0 0 24 24') {
  return function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={className}
        style={{ flex: 'none' }}
      >
        {path}
      </svg>
    );
  };
}

export const IconHome = svg(
  <>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
  </>,
);

export const IconProjects = svg(
  <>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="14" width="18" height="6" rx="1.5" />
    <path d="M7 9v5" />
  </>,
);

export const IconGraph = svg(
  <>
    <circle cx="5" cy="12" r="2.5" />
    <circle cx="19" cy="6" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M7.2 10.8 16.8 7.2M7.2 13.2l9.6 3.6" />
  </>,
);

export const IconSheet = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M3 14.5h18M9 4v16M15 4v16" />
  </>,
);

export const IconFlask = svg(
  <>
    <path d="M9 3h6M10 3v6.2L4.6 18a2 2 0 0 0 1.7 3h11.4a2 2 0 0 0 1.7-3L14 9.2V3" />
    <path d="M7.2 14h9.6" />
  </>,
);

export const IconJournal = svg(
  <>
    <path d="M5 3h12a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2V5a2 2 0 0 1 2-2Z" />
    <path d="M9 8h6M9 12h4" />
  </>,
);

export const IconCalendar = svg(
  <>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </>,
);

export const IconPlus = svg(<path d="M12 5v14M5 12h14" />);
export const IconMinus = svg(<path d="M5 12h14" />);
export const IconClose = svg(<path d="m6 6 12 12M18 6 6 18" />);
export const IconCheck = svg(<path d="m5 12.5 4.5 4.5L19 7" />);
export const IconChevronRight = svg(<path d="m9 5 7 7-7 7" />);
export const IconChevronDown = svg(<path d="m5 9 7 7 7-7" />);
export const IconChevronLeft = svg(<path d="m15 5-7 7 7 7" />);
export const IconSearch = svg(
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </>,
);
export const IconUndo = svg(
  <>
    <path d="M4 9h11a5 5 0 0 1 0 10h-6" />
    <path d="m4 9 4-4M4 9l4 4" />
  </>,
);
export const IconRedo = svg(
  <>
    <path d="M20 9H9a5 5 0 0 0 0 10h6" />
    <path d="m20 9-4-4M20 9l-4 4" />
  </>,
);
export const IconPlay = svg(<path d="M7 4.5v15l13-7.5Z" />);
export const IconPause = svg(
  <>
    <path d="M8.5 4.5v15M15.5 4.5v15" />
  </>,
);
export const IconTrash = svg(
  <>
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />
  </>,
);
export const IconEdit = svg(
  <>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
    <path d="m14.5 6.5 3 3" />
  </>,
);
export const IconClock = svg(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5.2l3.2 2" />
  </>,
);
export const IconLink = svg(
  <>
    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7l-1.3 1.3" />
    <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3" />
  </>,
);
export const IconSun = svg(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </>,
);
export const IconMoon = svg(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />);
export const IconWarning = svg(
  <>
    <path d="M12 4.5 21 19.5H3L12 4.5Z" />
    <path d="M12 10v4M12 16.7v.3" />
  </>,
);
export const IconBox = svg(
  <>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
  </>,
);
export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
  </>,
);
export const IconDrag = svg(
  <>
    <circle cx="9" cy="6" r="1.3" fill="currentColor" />
    <circle cx="15" cy="6" r="1.3" fill="currentColor" />
    <circle cx="9" cy="12" r="1.3" fill="currentColor" />
    <circle cx="15" cy="12" r="1.3" fill="currentColor" />
    <circle cx="9" cy="18" r="1.3" fill="currentColor" />
    <circle cx="15" cy="18" r="1.3" fill="currentColor" />
  </>,
);
export const IconImport = svg(
  <>
    <path d="M12 3v11" />
    <path d="m8 10.5 4 4 4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </>,
);
