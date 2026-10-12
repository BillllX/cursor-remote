// 工作区菜单里的文件夹图标

export function FolderMark({ className = "workspace-menu-folder" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.6 4.1h4.2l1.15 1.3H14.3v6.6c0 .6-.42 1-1 1H2.6c-.58 0-1-.4-1-1V4.1Z" fill="currentColor" />
    </svg>
  );
}
