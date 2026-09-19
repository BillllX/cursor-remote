export function JieboMark({ className = "logo" }: { className?: string }) {
  return (
    <img
      className={className}
      src="/icon.png"
      alt=""
      width={32}
      height={32}
      draggable={false}
    />
  );
}
