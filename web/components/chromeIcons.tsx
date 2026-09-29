export function IconAgent({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.2 11.2 3.5 13M8 3.2l1.3 3.1 3.3.3-2.5 2.2.8 3.2L8 10.4 4.9 12l.8-3.2-2.5-2.2 3.3-.3L8 3.2Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconPlan({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4.5h8M4 8h8M4 11.5h5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export function IconAsk({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.8 6.1a2.2 2.2 0 1 1 2.5 2.1V9.2M8.2 11.6h.01"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconWrite({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.2 3.6 12.4 6.8M3.5 12.5l.8-3.2L10.6 3l2.4 2.4-6.3 6.3-3.2.8Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconShield({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.6 12.5 4.4v3.4c0 2.6-1.9 4.4-4.5 5.6C5.4 12.2 3.5 10.4 3.5 7.8V4.4L8 2.6Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconCode({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m6 4.5-3.2 3.5L6 11.5M10 4.5l3.2 3.5L10 11.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconLive({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.35" />
      <path d="M2.8 8a5.2 5.2 0 0 1 10.4 0 5.2 5.2 0 0 1-10.4 0Z" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

export function IconDiff({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 3.5h7v9h-7zM8 3.5v9" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </svg>
  );
}

export function IconQuote({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.6 8h6.2a2.4 2.4 0 0 1 0 4.8M3.6 8 6.2 5.4M3.6 8l2.6 2.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconClose({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

export function IconRail({
  name,
  size = 16,
}: {
  name: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "stats";
  size?: number;
}) {
  const d =
    name === "chats"
      ? "M3 3.5h10v9H3zM6.2 3.5v9"
      : name === "files"
        ? "M2.8 5.2h3.6L7.6 3.6H13.2v8.8H2.8z"
        : name === "search"
          ? "M7.2 11.2a4 4 0 1 1 0-8 4 4 0 0 1 0 8ZM10.4 10.4 13.2 13.2"
          : name === "git"
            ? "M5 3.6v8.8M5 6.2c2.2 0 3.6-1.2 6-1.2v3.2c-2.4 0-3.8 1.2-6 1.2M5 4.2a1.1 1.1 0 1 0 .01 0M11 8.8a1.1 1.1 0 1 0 .01 0"
            : name === "terminal"
              ? "M3.4 4.8 7 8l-3.6 3.2M8.4 12.2h4.2"
              : name === "loop"
                ? "M11.4 5.2A4.2 4.2 0 0 0 4.6 6.4M4.6 10.8A4.2 4.2 0 0 0 11.4 9.6M11.4 3.4v2.2H9.2M4.6 12.6V10.4H6.8"
                : "M3.4 12.4V8.6M8 12.4V5.2M12.6 12.4V3.6";
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCollapse({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
