export function JieboMark({ className = "logo" }: { className?: string }) {
  return (
    <img
      className={className}
      src={`${process.env.NEXT_PUBLIC_BASE_PATH || ""}/icon.png`}
      alt=""
      width={32}
      height={32}
      draggable={false}
    />
  );
}
