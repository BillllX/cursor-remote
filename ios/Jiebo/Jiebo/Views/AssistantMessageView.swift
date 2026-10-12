import SwiftUI
import UIKit
import ImageIO

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
        ChunkedAssistantMessage(text: live ? (rendered ?? "") : transform(text))
            .equatable()
            .onAppear {
                latest = text
                if live { rendered = transform(text) }
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
                    rendered = transform(latest)
                    flush = nil
                }
            }
            .onChange(of: live) { _, isLive in
                flush?.cancel()
                flush = nil
                rendered = isLive ? transform(latest.isEmpty ? text : latest) : nil
            }
            .onDisappear {
                if live {
                    rendered = transform(latest.isEmpty ? text : latest)
                }
                flush?.cancel()
                flush = nil
            }
    }

    private func flushNow(_ value: String) {
        flush?.cancel()
        flush = nil
        rendered = transform(value)
    }
}

/// 正文按围栏外的空行切成段，每段是一个 equatable 的 AssistantMessage：
/// 流式时只有最后一段在变，前面的段不再重新拆块、解析表格和排版
private struct ChunkedAssistantMessage: View, Equatable {
    let text: String

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

    /// 围栏判定与 AssistantMessage.blocks 一致（行首 ```）。
    /// 返回值里 stableEnd 是最后一个「围栏外空行」之后的 UTF-8 偏移，stableCount 是它之前已经封口的段数。
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
            if line.hasPrefix("```") { inFence.toggle() }
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

/// 流式时正文只在末尾追加：上次已经封口的段直接复用，只扫新增的尾巴
@MainActor
private final class ChunkMemo {
    static let shared = ChunkMemo()
    private var stablePrefix = ""
    private var stableChunks: [String] = []

    func chunks(_ text: String) -> [String] {
        var head: [String] = []
        var tail = Substring(text)
        if !stablePrefix.isEmpty, text.hasPrefix(stablePrefix) {
            head = stableChunks
            tail = text[text.utf8.index(text.startIndex, offsetBy: stablePrefix.utf8.count)...]
        }
        let scanned = ChunkedAssistantMessage.scan(tail)
        let all = head + scanned.chunks
        if scanned.stableEnd > 0 {
            let consumed = (text.utf8.count - tail.utf8.count) + scanned.stableEnd
            stablePrefix = String(text[..<text.utf8.index(text.startIndex, offsetBy: consumed)])
            stableChunks = head + scanned.chunks.prefix(scanned.stableCount)
        } else if head.isEmpty {
            stablePrefix = ""
            stableChunks = []
        }
        return all.isEmpty ? [text] : all
    }
}

private struct AssistantMessage: View, Equatable {
    let text: String

    static func == (lhs: AssistantMessage, rhs: AssistantMessage) -> Bool {
        lhs.text == rhs.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code, let lang):
                    CodeBlockView(code: code, lang: lang)
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
            if line.hasPrefix("```") {
                if inCode {
                    result.append(.code(code.joined(separator: "\n"), lang: lang))
                    code = []
                    lang = ""
                    inCode = false
                } else {
                    flushProse()
                    lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    inCode = true
                }
                continue
            }
            if inCode { code.append(line) } else { prose.append(line) }
        }
        if inCode { result.append(.code(code.joined(separator: "\n"), lang: lang)) }
        flushProse()
        if result.isEmpty { result.append(.prose(text)) }
        return result
    }
}
