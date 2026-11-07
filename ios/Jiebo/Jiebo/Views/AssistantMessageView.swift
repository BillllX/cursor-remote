import SwiftUI
import UIKit
import ImageIO
import os

private let markdownStreamSignposter = OSSignposter(
    subsystem: Bundle.main.bundleIdentifier ?? "Jiebo",
    category: "WorkbenchMarkdown"
)

/// 流式时每个 token 都会改 text。界面只读 rendered：换行或 80ms 才排一次，停下立刻排完整版。
struct StreamingAssistantText: View {
    let text: String
    let live: Bool
    let transform: @MainActor (String) -> String

    @State private var rendered: String?
    @State private var latest = ""
    @State private var flush: Task<Void, Never>?

    var body: some View {
        // live 时禁止在 body 里 transform：父视图每个 token 都会重算，那会把节流绕开。
        ChunkedAssistantMessage(text: live ? (rendered ?? "") : measuredTransform(text))
            .equatable()
            .onAppear {
                latest = text
                if live { rendered = measuredTransform(text) }
            }
            .onChange(of: text) { old, value in
                latest = value
                guard live else { return }
                let appended = value.hasPrefix(old)
                let delta = appended ? String(value.dropFirst(old.count)) : ""
                if !appended || delta.contains("\n") {
                    flushNow(value)
                    return
                }
                guard flush == nil else { return }
                flush = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(80))
                    guard !Task.isCancelled else { return }
                    rendered = measuredTransform(latest)
                    flush = nil
                }
            }
            .onChange(of: live) { _, isLive in
                flush?.cancel()
                flush = nil
                rendered = isLive ? measuredTransform(latest.isEmpty ? text : latest) : nil
            }
            .onDisappear {
                if live {
                    rendered = measuredTransform(latest.isEmpty ? text : latest)
                }
                flush?.cancel()
                flush = nil
            }
    }

    private func flushNow(_ value: String) {
        flush?.cancel()
        flush = nil
        rendered = measuredTransform(value)
    }

    private func measuredTransform(_ value: String) -> String {
        let interval = markdownStreamSignposter.beginInterval("Markdown transform")
        defer { markdownStreamSignposter.endInterval("Markdown transform", interval) }
        return transform(value)
    }
}

/// 正文按围栏外的空行切成段，每段是一个 equatable 的 AssistantMessage：
/// 流式时只有最后一段在变，前面的段不再重新拆块、解析表格和排版
private struct ChunkedAssistantMessage: View, Equatable {
    let text: String
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: ChunkedAssistantMessage, rhs: ChunkedAssistantMessage) -> Bool {
        lhs.text == rhs.text && lhs.palette == rhs.palette && lhs.appearance == rhs.appearance
    }

    /// 段间距 = 原来一行空行的高度（5 + 12 + 5）
    private static let gap: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: Self.gap) {
            ForEach(Array(ChunkMemo.shared.chunks(text).enumerated()), id: \.offset) { _, chunk in
                AssistantMessage(text: chunk)
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
    private static let maxEntries = 8

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
    var palette: JieboPalette = JieboTheme.shared.palette
    var appearance: JieboAppearance = JieboTheme.shared.appearance

    static func == (lhs: AssistantMessage, rhs: AssistantMessage) -> Bool {
        lhs.text == rhs.text && lhs.palette == rhs.palette && lhs.appearance == rhs.appearance
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code, let lang):
                    CodeBlockView(code: code, lang: lang)
                case .liveCode(let code):
                    Text(code.isEmpty ? " " : code)
                        .font(JieboFont.mono(13))
                        .foregroundStyle(JieboColor.ink)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(JieboColor.well.opacity(0.6))
                        .clipShape(RoundedRectangle(cornerRadius: JieboRadius.md, style: .continuous))
                case .prose(let prose):
                    ProseLines(text: prose)
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

    private var blocks: [Block] {
        var result: [Block] = []
        var prose: [String] = []
        var code: [String] = []
        var lang = ""
        var inCode = false
        func flushProse() {
            let joined = prose.joined(separator: "\n")
            if joined.contains(where: { !$0.isNewline && !$0.isWhitespace }) {
                result.append(.prose(joined))
            }
            prose = []
        }
        for line in text.components(separatedBy: "\n") {
            let trimmedFence = line.drop { $0 == " " || $0 == "\t" }
            if trimmedFence.hasPrefix("```") || trimmedFence.hasPrefix("~~~") {
                if inCode {
                    result.append(.code(code.joined(separator: "\n"), lang: lang))
                    code = []
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
        if result.isEmpty { result.append(.prose(text)) }
        return result
    }
}
