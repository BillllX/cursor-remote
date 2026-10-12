// 搜索对话弹层
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Chat } from "../../lib/chat/types";

type SearchOverlayProps = {
  searchOpen: boolean;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  searchTrap: RefObject<HTMLDivElement | null>;
  searchQ: string;
  setSearchQ: Dispatch<SetStateAction<string>>;
  searchHits: Chat[];
  selectChat: (chat: Chat) => void;
  activeId: string;
  isAssistantChat: (id?: string) => boolean;
  assistantName: string;
};

export function SearchOverlay({
  searchOpen,
  setSearchOpen,
  searchTrap,
  searchQ,
  setSearchQ,
  searchHits,
  selectChat,
  activeId,
  isAssistantChat,
  assistantName,
}: SearchOverlayProps) {
  return (
    <div className={`search-overlay${searchOpen ? " open" : ""}`} onClick={() => setSearchOpen(false)}>
      <div
        ref={searchTrap}
        className="search-box"
        role="dialog"
        aria-modal="true"
        aria-label="搜索对话"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus={searchOpen}
          className="search-input"
          placeholder="搜索对话"
          value={searchQ}
          onChange={(event) => setSearchQ(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setSearchOpen(false);
            if (event.key === "Enter" && searchHits[0]) selectChat(searchHits[0]);
          }}
        />
        <div className="search-list">
          {searchHits.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`search-item${chat.id === activeId ? " active" : ""}`}
              onClick={() => selectChat(chat)}
            >
              {isAssistantChat(chat.id) ? assistantName : chat.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
