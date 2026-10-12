// 没有对话内容时的起始页
import { friendlyError } from "../../lib/chat/format";
import { EMPTY_STARTERS } from "../../lib/chat/sessions";
import { JieboMark as Mark } from "../JieboMark";

type EmptyStateProps = {
  error: string;
  notice: string;
  openFilesBrowser: () => void;
  applyDraft: (value: string, caret?: number) => void;
};

export function EmptyState({ error, notice, openFilesBrowser, applyDraft }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Mark />
      </div>
      <h1>从这里开始</h1>
      <p className="empty-lead">网页说话，远端动手。从左侧接着聊，或先打开一个工作区文件。</p>
      {error ? <div className="error-line">{friendlyError(error)}</div> : null}
      {notice ? <div className="notice-line">{notice}</div> : null}
      <div className="empty-starters">
        <button type="button" className="empty-chip" onClick={openFilesBrowser}>
          打开工作区文件
        </button>
        {EMPTY_STARTERS.map((text) => (
          <button key={text} type="button" className="empty-chip" onClick={() => applyDraft(text, text.length)}>
            {text}
          </button>
        ))}
      </div>
      <p className="empty-foot empty-foot-portrait">点左上角打开对话列表 · 可粘贴图片</p>
      <p className="empty-foot empty-foot-land">对话列表在左侧 · 可粘贴图片</p>
    </div>
  );
}
