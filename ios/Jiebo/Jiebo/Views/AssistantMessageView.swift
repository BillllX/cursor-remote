import SwiftUI
import UIKit
import ImageIO
import os

private let markdownStreamSignposter = OSSignposter(
    subsystem: Bundle.main.bundleIdentifier ?? "Jiebo",
    category: "WorkbenchMarkdown"
)

/// 流式时每个 token 都会改 text。界面只读 rendered：固定节奏（66ms）排一次，停下立刻排完整版。
/// @路径 链接转换已下沉到分段级 AssistantMessage，避免流式每次刷新对全文跑 O(N^2) 正则。
struct StreamingAssistantText: View {
    let text: String
    let live: Bool
    var linkFileMentions: Bool = true

    @State private var rendered: String?
    @State private var latest: String
    @State private var flush: Task<Void, Never>?

    init(text: String, live: Bool, linkFileMentions: Bool = true) {
        self.text = text
        self.live = live
        self.linkFileMentions = linkFileMentions
        _rendered = State(initialValue: live ? text : nil)
        _latest = State(initialValue: text)
    }

    var body: some View {
        ChunkedAssistantMessage(
            text: live ? (rendered ?? text) : text,
            linkFileMentions: linkFileMentions
        )
        .equatable()
        .onAppear {
            latest = text
            if live { rendered = text }
        }
        .onChange(of: text) { old, value in
            latest = value
            guard live else { return }
            if !Self.isLikelyAppend(old: old, new: value) {
                flushNow(value)
                return
            }
            guard flush == nil else { return }
            flush = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(66))
                guard !Task.isCancelled else { return }
                let interval = markdownStreamSignposter.beginInterval("Markdown flush")
                rendered = latest
                markdownStreamSignposter.endInterval("Markdown flush", interval)
                flush = nil
            }
        }
        .onChange(of: live) { _, isLive in
            flush?.cancel()
            flush = nil
            latest = text
            rendered = isLive ? text : nil
        }
        .onDisappear {
            if live {
                rendered = latest.isEmpty ? text : latest
            }
            flush?.cancel()
            flush = nil
        }
    }

    private func flushNow(_ value: String) {
        flush?.cancel()
        flush = nil
        rendered = value
    }

    /// O(1) 流式追加判定：超过 256B 时仅抽检前 64B 与旧尾 64B，避免每 50ms 对数万字节全文跑 hasPrefix。
    private static func isLikelyAppend(old: String, new: String) -> Bool {
        let oldCount = old.utf8.count
        let newCount = new.utf8.count
        guard newCount >= oldCount else { return false }
        if oldCount <= 256 { return new.hasPrefix(old) }
        let sample = 64
        let oldUtf8 = old.utf8
        let newUtf8 = new.utf8
        let oldHeadEnd = oldUtf8.index(oldUtf8.startIndex, offsetBy: sample)
        let newHeadEnd = newUtf8.index(newUtf8.startIndex, offsetBy: sample)
        guard oldUtf8[oldUtf8.startIndex..<oldHeadEnd].elementsEqual(newUtf8[newUtf8.startIndex..<newHeadEnd]) else {
            return false
        }
        let tailOffset = oldCount - sample
        let oldTailStart = oldUtf8.index(oldUtf8.startIndex, offsetBy: tailOffset)
        let newTailStart = newUtf8.index(newUtf8.startIndex, offsetBy: tailOffset)
        let newTailEnd = newUtf8.index(newTailStart, offsetBy: sample)
        return oldUtf8[oldTailStart..<oldUtf8.endIndex].elementsEqual(newUtf8[newTailStart..<newTailEnd])
    }
}

/// 正文按围栏外的空行切成段，每段是一个 equatable 的 AssistantMessage：
/// 流式时只有最后一段在变，前面的段不再重新拆块、解析表格和排版
struct ChunkedAssistantMessage: View, Equatable {
    let text: String
    var linkFileMentions: Bool = false
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: ChunkedAssistantMessage, rhs: ChunkedAssistantMessage) -> Bool {
        lhs.text == rhs.text
            && lhs.linkFileMentions == rhs.linkFileMentions
            && lhs.palette == rhs.palette
            && lhs.appearance == rhs.appearance
    }

    /// 正文、标题与段距一起跟随系统大字体，流式分段与缓存方式保持一致。
    @ScaledMetric(relativeTo: .body) private var paragraphSpacing = JieboReading.paragraphSpacing

    var body: some View {
        VStack(alignment: .leading, spacing: paragraphSpacing) {
            ForEach(Array(ChunkMemo.shared.chunks(text).enumerated()), id: \.offset) { _, chunk in
                AssistantMessage(text: chunk, linkFileMentions: linkFileMentions)
                    .equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 围栏判定与 AssistantMessage.blocks 一致（允许前导空格的 ``` 或 ~~~）。
    /// 返回值里 stableEnd 是最后一个「围栏外空行」之后的 UTF-8 偏移，stableCount 是它之前已经封口的段数。
    static func isFenceLine(_ line: Substring) -> Bool {
        let trimmed = line.drop { $0 == " " || $0 == "\t" }
        return trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
    }

    static func scan(_ text: Substring) -> (chunks: [String], stableEnd: Int, stableCount: Int) {
        var result: [String] = []
        var current: [Substring] = []
        var inFence = false
        var offset = 0
        var stableEnd = 0
        var stableCount = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let next = offset + line.utf8.count + 1
            defer { offset = next }
            if isFenceLine(line) { inFence.toggle() }
            if !inFence, line.allSatisfy({ $0 == " " || $0 == "\t" }) {
                if !current.isEmpty {
                    result.append(current.joined(separator: "\n"))
                    current = []
                }
                // 末行的空串只是还没写完的换行，后面的字会接在这一行上，不算封口
                if next <= text.utf8.count {
                    stableEnd = next
                    stableCount = result.count
                }
                continue
            }
            current.append(line)
        }
        if !current.isEmpty { result.append(current.joined(separator: "\n")) }
        return (result, stableEnd, stableCount)
    }
}

/// 流式时正文只在末尾追加：保留多槽位前缀缓存，避免多窗口或同屏多气泡重绘时互相冲掉缓存
@MainActor
private final class ChunkMemo {
    static let shared = ChunkMemo()
    private struct Entry {
        var prefix: String
        var chunks: [String]
    }
    private var entries: [Entry] = []
    private static let maxEntries = 32

    func chunks(_ text: String) -> [String] {
        var head: [String] = []
        var tail = Substring(text)
        var matchedIndex: Int?
        for (index, entry) in entries.enumerated() where !entry.prefix.isEmpty && text.hasPrefix(entry.prefix) {
            if let currentBest = matchedIndex {
                if entry.prefix.utf8.count > entries[currentBest].prefix.utf8.count {
                    matchedIndex = index
                }
            } else {
                matchedIndex = index
            }
        }
        if let idx = matchedIndex {
            let entry = entries[idx]
            head = entry.chunks
            tail = text[text.utf8.index(text.startIndex, offsetBy: entry.prefix.utf8.count)...]
        }
        let scanned = ChunkedAssistantMessage.scan(tail)
        let all = head + scanned.chunks
        if scanned.stableEnd > 0 {
            let consumed = (text.utf8.count - tail.utf8.count) + scanned.stableEnd
            let newPrefix = String(text[..<text.utf8.index(text.startIndex, offsetBy: consumed)])
            let newChunks = head + Array(scanned.chunks.prefix(scanned.stableCount))
            if let idx = matchedIndex {
                entries[idx] = Entry(prefix: newPrefix, chunks: newChunks)
            } else {
                if entries.count >= Self.maxEntries { entries.removeFirst() }
                entries.append(Entry(prefix: newPrefix, chunks: newChunks))
            }
        }
        return all.isEmpty ? [text] : all
    }
}

private struct AssistantMessage: View, Equatable {
    let text: String
    var linkFileMentions: Bool = false
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: AssistantMessage, rhs: AssistantMessage) -> Bool {
        lhs.text == rhs.text
            && lhs.linkFileMentions == rhs.linkFileMentions
            && lhs.palette == rhs.palette
            && lhs.appearance == rhs.appearance
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks(of: text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code, let lang):
                    CodeBlockView(code: code, lang: lang)
                case .liveCode(let code):
                    LiveCodeBlockView(code: code)
                        .equatable()
                case .prose(let prose):
                    ProseLines(text: linkFileMentions ? TurnView.linkMentionsProse(prose) : prose)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private enum Block {
        case prose(String)
        case code(String, lang: String)
        /// 围栏还没闭合。只画尾部纯文本，闭合后再换成代码块。
        case liveCode(String)
    }

    private func blocks(of source: String) -> [Block] {
        var result: [Block] = []
        var prose: [Substring] = []
        var code: [Substring] = []
        var lang = ""
        var inCode = false
        func flushProse() {
            guard !prose.isEmpty else { return }
            let joined = prose.joined(separator: "\n")
            if joined.contains(where: { !$0.isNewline && !$0.isWhitespace }) {
                result.append(.prose(joined))
            }
            prose.removeAll(keepingCapacity: true)
        }
        for line in source.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }) {
            let trimmedFence = line.drop { $0 == " " || $0 == "\t" }
            if trimmedFence.hasPrefix("```") || trimmedFence.hasPrefix("~~~") {
                if inCode {
                    result.append(.code(code.joined(separator: "\n"), lang: lang))
                    code.removeAll(keepingCapacity: true)
                    lang = ""
                    inCode = false
                } else {
                    flushProse()
                    lang = String(trimmedFence.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line) } else { prose.append(line) }
        }
        if inCode {
            let tail = code.count > 24 ? code.suffix(24).joined(separator: "\n") : code.joined(separator: "\n")
            result.append(.liveCode(tail))
        }
        flushProse()
        if result.isEmpty { result.append(.prose(source)) }
        return result
    }
}

private struct LiveCodeBlockView: View, Equatable {
    let code: String
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: LiveCodeBlockView, rhs: LiveCodeBlockView) -> Bool {
        lhs.code == rhs.code && lhs.palette == rhs.palette && lhs.appearance == rhs.appearance
    }

    var body: some View {
        Text(code.isEmpty ? " " : code)
            .font(JieboFont.mono(13))
            .foregroundStyle(JieboColor.ink)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(JieboColor.well.opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
    }
}
