interface IconProps {
  className?: string;
}

const base = 'inline-block';

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={`${base} ${className ?? 'h-6 w-6'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const GaugeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 14a8 8 0 1 1 16 0" />
    <path d="M12 14l3.5-3.5" />
    <path d="M4 18h16" />
  </Svg>
);

export const ScaleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 17l4-9 4 9" />
    <path d="M13 13l4-9 4 9" />
    <path d="M3 17a4 4 0 0 0 8 0M13 13a4 4 0 0 0 8 0" />
  </Svg>
);

export const TrendIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6l6 6 4-4 8 8" />
    <path d="M21 11v5h-5" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  </Svg>
);

export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);

export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
);

export const BarcodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6v12M8 6v12M11 6v12M14 6v12M17 6v12M20 6v12" strokeWidth="1.4" />
  </Svg>
);

export const FlameIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3s5 4.5 5 9.5a5 5 0 0 1-10 0C7 9 9 7 9 7s0 3 2 3c0-3 1-7 1-7z" />
  </Svg>
);

export const WarnIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4L2.5 20h19L12 4z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="17" r="0.5" fill="currentColor" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2L8 5h8l1.5 2h2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    <circle cx="12" cy="13" r="3.2" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5h6v2" />
    <path d="M6 7l1 12h10l1-12" />
    <path d="M10 11v5M14 11v5" />
  </Svg>
);

export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="6" r="3" />
    <path d="M12 9v6" />
    <path d="M7 12.5c2-1.5 8-1.5 10 0" />
    <path d="M12 15l-3 6M12 15l3 6" />
  </Svg>
);

export const FlagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 21V4" />
    <path d="M6 4h11l-2.5 4L17 12H6" />
  </Svg>
);

export const ListIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

/** An open book, for recipes. */
export const BookIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 6.5v13M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2M12 6.5c1.5-1.5 3.5-2 8-2v13c-4.5 0-6.5.5-8 2" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
);
