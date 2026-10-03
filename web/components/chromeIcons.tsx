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
  name: "chats" | "files" | "search" | "git" | "terminal" | "loop" | "stats" | "assistant";
  size?: number;
}) {
  const [tint, line] = RAIL[name];
  return (
    <svg className="chrome-icon rail-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {tint ? <path className="rail-icon-tint" d={tint} fill="currentColor" /> : null}
      <path d={line} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// [填充底色, 线稿]，16 格，线宽 1.4。
const RAIL: Record<"chats" | "files" | "search" | "git" | "terminal" | "loop" | "stats" | "assistant", [string, string]> = {
  chats: [
    "M3.6 3.2h8.8a1.4 1.4 0 0 1 1.4 1.4v5.4a1.4 1.4 0 0 1-1.4 1.4H7.4l-2.8 2.1v-2.1h-1a1.4 1.4 0 0 1-1.4-1.4V4.6a1.4 1.4 0 0 1 1.4-1.4Z",
    "M3.6 3.2h8.8a1.4 1.4 0 0 1 1.4 1.4v5.4a1.4 1.4 0 0 1-1.4 1.4H7.4l-2.8 2.1v-2.1h-1a1.4 1.4 0 0 1-1.4-1.4V4.6a1.4 1.4 0 0 1 1.4-1.4ZM5.4 6h5.2M5.4 8.4h3.2",
  ],
  files: [
    "M2.4 5.6h11.2v6.2a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2Z",
    "M2.4 4.2A1.2 1.2 0 0 1 3.6 3h2.6l1.4 1.6h4.8a1.2 1.2 0 0 1 1.2 1.2v6a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2ZM2.4 6.6h11.2",
  ],
  search: [
    "M7 10.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2Z",
    "M7 10.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2ZM9.7 9.7l3.4 3.4M5.4 6.2A1.8 1.8 0 0 1 7 5.2",
  ],
  git: [
    "",
    "M4.8 5.4v5.2M4.8 3.3a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM4.8 10.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM11.2 3.3a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM11.2 6.5c0 2.6-6.4 1.6-6.4 4",
  ],
  terminal: [
    "M3.4 2.8h9.2a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2a1.4 1.4 0 0 1 1.4-1.4Z",
    "M3.4 2.8h9.2a1.4 1.4 0 0 1 1.4 1.4v7.6a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11.8V4.2a1.4 1.4 0 0 1 1.4-1.4ZM4.8 6.2 6.8 8l-2 1.8M8.4 10h2.8",
  ],
  loop: [
    "",
    "M12.6 6.6A4.8 4.8 0 0 0 3.8 5.4M3.4 9.4a4.8 4.8 0 0 0 8.8 1.2M12.8 3.6v3h-3M3.2 12.4v-3h3",
  ],
  assistant: [
    "M8 2.6c.4 2.4 1.4 3.4 3.8 3.8-2.4.4-3.4 1.4-3.8 3.8-.4-2.4-1.4-3.4-3.8-3.8 2.4-.4 3.4-1.4 3.8-3.8Z",
    "M8 2.6c.4 2.4 1.4 3.4 3.8 3.8-2.4.4-3.4 1.4-3.8 3.8-.4-2.4-1.4-3.4-3.8-3.8 2.4-.4 3.4-1.4 3.8-3.8ZM12.2 10.4v2.8M10.8 11.8h2.8M3.8 11.6h.01",
  ],
  stats: [
    "M7 6.4h2v6.2H7zM11.2 3.6h2v9h-2zM2.8 9h2v3.6h-2z",
    "M7 6.4h2v6.2H7zM11.2 3.6h2v9h-2zM2.8 9h2v3.6h-2zM2 13.4h12",
  ],
};

export function IconCollapse({ size = 14 }: { size?: number }) {
  return (
    <svg className="chrome-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
