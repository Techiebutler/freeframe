/**
 * Inline icon set. CEP panels load from file:// with no network fetch for
 * assets, so every glyph is a local SVG rather than an icon font.
 */
import type { SVGProps } from "react";

const Svg = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
);

export const IconPlay = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <rect x="6.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconChevronLeft = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);

export const IconChevronUp = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M5 15l7-7 7 7" />
  </Svg>
);

export const IconChevronDown = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M5 9l7 7 7-7" />
  </Svg>
);

export const IconFolder = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

/** Solid folder for folder tiles: reads as a container at a glance. */
export const IconFolderFilled = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path
      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
      fill="currentColor"
      fillOpacity="0.22"
    />
    <path d="M3 10h18" />
  </Svg>
);

export const IconFilm = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 12h18M3 8h4M3 16h4M17 8h4M17 16h4" />
  </Svg>
);

export const IconLink = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M10 13a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
    <path d="M14 11a4 4 0 0 0-5.7-.4L5.7 13.2a4 4 0 0 0 5.7 5.7l1.5-1.5" />
  </Svg>
);

export const IconCheck = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Svg>
);

export const IconReply = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M9 7L4 12l5 5" />
    <path d="M4 12h9a7 7 0 0 1 7 7v1" />
  </Svg>
);

export const IconExternal = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Svg>
);

export const IconRefresh = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M20 11a8 8 0 1 0-.6 4" />
    <path d="M20 4v7h-7" />
  </Svg>
);

export const IconSearch = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.3-4.3" />
  </Svg>
);

export const IconSettings = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </Svg>
);

export const IconMarker = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M6 3h12l-3 5 3 5H6z" />
    <path d="M6 3v18" />
  </Svg>
);

export const IconTrash = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
  </Svg>
);

export const IconUpload = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M12 16V4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Svg>
);

export const IconGrid = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Svg>
);

export const IconComment = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
  </Svg>
);

export const IconSend = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M20 4L3 10.5l7 2.5 2.5 7z" />
    <path d="M20 4l-10 9" />
  </Svg>
);

export const IconVolume = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M5 9v6h3.5L13 19V5L8.5 9z" />
    <path d="M16.5 9.5a3.5 3.5 0 0 1 0 5" />
  </Svg>
);

export const IconVolumeOff = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M5 9v6h3.5L13 19V5L8.5 9z" />
    <path d="M17 10l4 4M21 10l-4 4" />
  </Svg>
);

export const IconFilter = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8 10h8M10 13.5h4" />
  </Svg>
);

export const IconSort = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 7h13M4 12h9M4 17h5" />
    <path d="M16 8v9M13 14l3 3 3-3" />
  </Svg>
);

export const IconClose = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconAnnotation = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z" />
  </Svg>
);

export const IconAttachment = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M19.5 11l-7.6 7.6a4.5 4.5 0 0 1-6.4-6.4l8.1-8.1a3 3 0 0 1 4.3 4.3l-8.1 8.1a1.5 1.5 0 0 1-2.1-2.1l7.2-7.2" />
  </Svg>
);

export const IconCircle = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
  </Svg>
);

export const IconCheckCircle = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </Svg>
);

export const IconPerson = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Svg>
);

export const IconClock = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const IconHome = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
  </Svg>
);

export const IconEmoji = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </Svg>
);

export const IconCopy = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </Svg>
);

export const IconRename = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 7V5h9v2M8.5 5v14M6.5 19h4" />
    <path d="M15 19l5-5-2-2-5 5v2z" />
  </Svg>
);

export const IconEyeOff = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2" />
    <path d="M4 4l16 16" />
  </Svg>
);

export const IconLoop = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 12a5 5 0 0 1 5-5h9" />
    <path d="M15 4l3 3-3 3" />
    <path d="M20 12a5 5 0 0 1-5 5H6" />
    <path d="M9 20l-3-3 3-3" />
  </Svg>
);

export const IconSkipBack = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M18 6v12l-9-6z" fill="currentColor" stroke="none" />
    <path d="M6 5v14" />
  </Svg>
);

export const IconSkipForward = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M6 6v12l9-6z" fill="currentColor" stroke="none" />
    <path d="M18 5v14" />
  </Svg>
);

export const IconMore = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconAlert = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M12 4.5l8.5 15h-17z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);

export const IconAppearance = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M4 8h4M12 8h8M4 16h10M18 16h2" />
    <circle cx="10" cy="8" r="2" />
    <circle cx="16" cy="16" r="2" />
  </Svg>
);

export const IconSortArrows = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M8 4v16M5 17l3 3 3-3" />
    <path d="M16 20V4M13 7l3-3 3 3" />
  </Svg>
);

export const IconShare = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="18" cy="5.5" r="2.5" />
    <circle cx="6" cy="12" r="2.5" />
    <circle cx="18" cy="18.5" r="2.5" />
    <path d="M8.2 10.8l7.6-4M8.2 13.2l7.6 4" />
  </Svg>
);

export const IconDownload = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M12 4v12" />
    <path d="M7 11l5 5 5-5" />
    <path d="M4 19h16" />
  </Svg>
);

export const IconPlus = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconCloudUpload = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M7 18a4.5 4.5 0 0 1-.5-8.97 6 6 0 0 1 11.6 1.62A3.9 3.9 0 0 1 17.5 18" />
    <path d="M12 21v-9M8.5 15L12 11.5 15.5 15" />
  </Svg>
);

export const IconInfo = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </Svg>
);

export const IconGlobe = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17z" />
  </Svg>
);

export const IconKey = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <circle cx="8" cy="15" r="3.5" />
    <path d="M10.6 12.6L19 4.2M16.4 6.8l2 2M14 9.2l2 2" />
  </Svg>
);

export const IconDroplet = (props: SVGProps<SVGSVGElement>) => (
  <Svg {...props}>
    <path d="M12 3.5s6 6.3 6 10.2a6 6 0 0 1-12 0c0-3.9 6-10.2 6-10.2z" />
  </Svg>
);
