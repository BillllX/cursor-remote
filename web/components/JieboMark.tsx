export function JieboMark({ className = "logo" }: { className?: string }) {
  return (
    <img
      className={className}
      src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/favicon.svg`}
      alt=""
      width={32}
      height={32}
      draggable={false}
    />
  );
}

export function JieboGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9.6" y="10.4" width="11.4" height="10.4" rx="2.6" fill="currentColor" opacity="0.28" />
      <path d="M12.6 14.2 14.6 15.6 12.6 17M16.2 17.4h2.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M9 3.4c3.3 0 5.9 2.2 5.9 5s-2.6 5-5.9 5c-.7 0-1.4-.1-2.1-.3l-2.3 1.4c-.3.2-.6 0-.6-.4v-2.6c-.8-.9-1-1.9-1-3.1 0-2.8 2.6-5 5.9-5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
