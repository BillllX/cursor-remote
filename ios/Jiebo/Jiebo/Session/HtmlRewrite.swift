import Foundation

// 移植 web/lib/preview.ts 的 resolveAssetPath / mediaSrc / rewriteHtml，
// 让 html/markdown 预览的相对资源经 /media 票据加载，并注入 CSP（对齐网页沙箱强度）。

/// 相对路径 → 工作区路径（对齐网页 resolveAssetPath：#/协议/绝对 URL 返回 nil）
func resolveAssetPath(fromFile: String, href: String) -> String? {
    let raw = href.trimmingCharacters(in: .whitespaces)
    if raw.isEmpty || raw.hasPrefix("#") || raw.hasPrefix("//") { return nil }
    if raw.range(of: #"^[a-z][a-z0-9+.-]*:"#, options: .regularExpression) != nil { return nil }
    let clean = raw.split(separator: "#").first.map(String.init)?.split(separator: "?").first.map(String.init) ?? ""
    if clean.isEmpty { return nil }
    var from = fromFile.replacingOccurrences(of: "\\", with: "/")
    if from.hasPrefix("./") { from.removeFirst(2) }
    let dir = from.contains("/") ? String(from.prefix(upTo: from.lastIndex(of: "/")!)) : ""
    var out: [String] = dir.isEmpty ? [] : dir.split(separator: "/").map(String.init)
    for part in clean.split(separator: "/").map(String.init) {
        if part.isEmpty || part == "." { continue }
        if part == ".." {
            if out.isEmpty { return nil }
            out.removeLast()
            continue
        }
        out.append(part)
    }
    return out.joined(separator: "/")
}

/// 拼 /media 票据 URL（对齐网页 mediaSrc；返回相对地址，由 GatewayConfig.resolveHTTP 补全）
func mediaSrc(path: String, chatId: String, media: MediaTicket?, rev: String? = nil) -> String? {
    guard !path.isEmpty, !chatId.isEmpty, let media else { return nil }
    var comps = URLComponents()
    comps.path = "/media"
    var query: [URLQueryItem] = [
        URLQueryItem(name: "path", value: path),
        URLQueryItem(name: "chatId", value: chatId),
        URLQueryItem(name: "exp", value: String(media.exp)),
        URLQueryItem(name: "sig", value: media.sig),
    ]
    if let rev { query.append(URLQueryItem(name: "rev", value: rev)) }
    comps.queryItems = query
    return comps.string
}

private let cspMeta = "<meta http-equiv=\"Content-Security-Policy\" content=\"base-uri 'none'; object-src 'none'; form-action 'none'\">"

/// 重写 html 的 src/href（对齐网页 rewriteHtml）：相对资源 → toSrc(工作区路径)，
/// http 的 src 只放行常见静态扩展，javascript: 剥成空，最后注入 CSP
func rewriteHtml(source: String, fromFile: String, toSrc: (String) -> String) -> String {
    guard let regex = try? NSRegularExpression(pattern: #"(?i)(\s)(src|href)=(["'])([^"']*)\3"#, options: []) else { return source }
    let nsSource = source as NSString
    let matches = regex.matches(in: source, range: NSRange(location: 0, length: nsSource.length))
    var result = ""
    var cursor = 0
    for match in matches {
        let full = match.range
        result += nsSource.substring(with: NSRange(location: cursor, length: full.location - cursor))
        let space = nsSource.substring(with: match.range(at: 1))
        let attr = nsSource.substring(with: match.range(at: 2))
        let quote = nsSource.substring(with: match.range(at: 3))
        let url = nsSource.substring(with: match.range(at: 4))
        let raw = url.trimmingCharacters(in: .whitespaces)
        let lower = attr.lowercased()
        var replacement = nsSource.substring(with: full)
        if raw.isEmpty || raw.hasPrefix("#") || raw.hasPrefix("data:") || raw.hasPrefix("blob:") {
            // 原样保留
        } else if raw.lowercased().hasPrefix("javascript:") {
            replacement = "\(space)\(attr)=\(quote)\(quote)"
        } else if raw.lowercased().hasPrefix("http://") || raw.lowercased().hasPrefix("https://") {
            if lower == "href" {
                // 原样保留
            } else if lower == "src", raw.range(of: #"\.(css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)(\?|$)"#, options: .regularExpression) != nil {
                // 原样保留
            } else {
                replacement = "\(space)\(attr)=\(quote)\(quote)"
            }
        } else if let resolved = resolveAssetPath(fromFile: fromFile, href: raw) {
            replacement = "\(space)\(attr)=\(quote)\(toSrc(resolved))\(quote)"
        } else {
            replacement = "\(space)\(attr)=\(quote)\(quote)"
        }
        result += replacement
        cursor = full.location + full.length
    }
    result += nsSource.substring(from: cursor)

    // 注入 CSP（对齐网页：有 <head> 插 head 后，有 <html> 补 head，否则整篇包一层）。
    // 注意 <head[^>]*> 会误匹配 <header>（网页同款 bug），这里用 (?:\s[^>]*)? 收紧
    if let range = result.range(of: #"<head(?:\s[^>]*)?>"#, options: .regularExpression) {
        result.insert(contentsOf: cspMeta, at: range.upperBound)
        return result
    }
    if let range = result.range(of: #"<html[^>]*>"#, options: .regularExpression) {
        result.insert(contentsOf: "<head>\(cspMeta)</head>", at: range.upperBound)
        return result
    }
    return "<!doctype html><html><head><meta charset=\"utf-8\">\(cspMeta)</head><body>\(result)</body></html>"
}

// MARK: - Markdown → HTML（紧凑转换器，覆盖常见语法；图片经 rewriteHtml 走票据）

/// 把 markdown 转成带 CSP + Jiebo 风格的完整 html 文档
func markdownToHtmlDocument(_ markdown: String, fromFile: String, toSrc: (String) -> String) -> String {
    let body = markdownBodyToHtml(markdown)
    let html = """
    <!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
    body { font: 15px/1.65 -apple-system, sans-serif; color: #1A1A1A; margin: 16px; }
    h1, h2, h3, h4 { line-height: 1.3; margin: 1.1em 0 0.5em; }
    h1 { font-size: 1.5em; } h2 { font-size: 1.3em; } h3 { font-size: 1.15em; }
    code { font-family: ui-monospace, monospace; font-size: 0.88em; background: #F5F5F5; padding: 1px 5px; border-radius: 4px; }
    pre { background: #F5F5F5; padding: 12px; border-radius: 8px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 0.8em 0; padding-left: 12px; border-left: 3px solid #ECECEC; color: #737373; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    a { color: #2F6F5E; text-decoration: none; }
    ul, ol { padding-left: 1.4em; }
    hr { border: none; border-top: 1px solid #ECECEC; margin: 1.2em 0; }
    table { border-collapse: collapse; } td, th { border: 1px solid #ECECEC; padding: 4px 10px; }
    </style></head><body>\(body)</body></html>
    """
    return rewriteHtml(source: html, fromFile: fromFile, toSrc: toSrc)
}

private func escapeHtml(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}

/// 行内语法：`code`、**bold**、*italic*、~~strike~~、![img](src)、[text](url)
private func inlineMarkdown(_ text: String) -> String {
    var out = escapeHtml(text)
    out = out.replacingOccurrences(of: #"!\[([^\]]*)\]\(([^)\s]+)[^)]*\)"#, with: "<img alt=\"$1\" src=\"$2\">", options: .regularExpression)
    out = out.replacingOccurrences(of: #"\[([^\]]+)\]\(([^)\s]+)[^)]*\)"#, with: "<a href=\"$2\">$1</a>", options: .regularExpression)
    out = out.replacingOccurrences(of: #"`([^`]+)`"#, with: "<code>$1</code>", options: .regularExpression)
    out = out.replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "<strong>$1</strong>", options: .regularExpression)
    out = out.replacingOccurrences(of: #"(?<![*\w])\*([^*\n]+)\*(?![*\w])"#, with: "<em>$1</em>", options: .regularExpression)
    out = out.replacingOccurrences(of: #"~~([^~]+)~~"#, with: "<del>$1</del>", options: .regularExpression)
    return out
}

/// 块级语法：fenced code、标题、hr、引用、列表、表格、段落
private func markdownBodyToHtml(_ markdown: String) -> String {
    let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var html = ""
    var index = 0
    var inCode = false
    var codeBuffer = ""
    var listType: String? // "ul" / "ol"
    var paragraph: [String] = []

    func flushParagraph() {
        guard !paragraph.isEmpty else { return }
        html += "<p>" + paragraph.map(inlineMarkdown).joined(separator: "<br>") + "</p>"
        paragraph = []
    }
    func flushList() {
        if let listType { html += "</\(listType)>" }
        listType = nil
    }

    while index < lines.count {
        let line = lines[index]
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("```") {
            if inCode {
                html += "<pre><code>" + escapeHtml(codeBuffer) + "</code></pre>"
                codeBuffer = ""
                inCode = false
            } else {
                flushParagraph(); flushList()
                inCode = true
            }
            index += 1
            continue
        }
        if inCode {
            codeBuffer += line + "\n"
            index += 1
            continue
        }
        if trimmed.isEmpty {
            flushParagraph(); flushList()
            index += 1
            continue
        }
        if let heading = trimmed.range(of: #"^(#{1,6})\s+(.*)$"#, options: .regularExpression) {
            flushParagraph(); flushList()
            let text = String(trimmed[heading])
            let level = text.prefix(while: { $0 == "#" }).count
            let content = String(text.dropFirst(level)).trimmingCharacters(in: .whitespaces)
            html += "<h\(level)>" + inlineMarkdown(content) + "</h\(level)>"
            index += 1
            continue
        }
        if trimmed.range(of: #"^(-{3,}|\*{3,})$"#, options: .regularExpression) != nil {
            flushParagraph(); flushList()
            html += "<hr>"
            index += 1
            continue
        }
        if trimmed.hasPrefix("> ") || trimmed == ">" {
            flushParagraph(); flushList()
            var quote: [String] = []
            while index < lines.count {
                let q = lines[index].trimmingCharacters(in: .whitespaces)
                if q.hasPrefix("> ") { quote.append(String(q.dropFirst(2))) }
                else if q == ">" { quote.append("") }
                else { break }
                index += 1
            }
            html += "<blockquote>" + quote.map(inlineMarkdown).joined(separator: "<br>") + "</blockquote>"
            continue
        }
        if trimmed.range(of: #"^[-*+]\s+"#, options: .regularExpression) != nil {
            flushParagraph()
            if listType != "ul" { flushList(); html += "<ul>"; listType = "ul" }
            let item = trimmed.replacingOccurrences(of: #"^[-*+]\s+"#, with: "", options: .regularExpression)
            html += "<li>" + inlineMarkdown(item) + "</li>"
            index += 1
            continue
        }
        if trimmed.range(of: #"^\d+[.)]\s+"#, options: .regularExpression) != nil {
            flushParagraph()
            if listType != "ol" { flushList(); html += "<ol>"; listType = "ol" }
            let item = trimmed.replacingOccurrences(of: #"^\d+[.)]\s+"#, with: "", options: .regularExpression)
            html += "<li>" + inlineMarkdown(item) + "</li>"
            index += 1
            continue
        }
        // 表格：| a | b | 紧跟 |---|---|
        if trimmed.hasPrefix("|"), index + 1 < lines.count,
           lines[index + 1].trimmingCharacters(in: .whitespaces).range(of: #"^\|[\s:|-]+\|$"#, options: .regularExpression) != nil
        {
            flushParagraph(); flushList()
            let cells = trimmed.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            html += "<table><thead><tr>" + cells.map { "<th>" + inlineMarkdown($0) + "</th>" }.joined() + "</tr></thead><tbody>"
            index += 2
            while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                let row = lines[index].trimmingCharacters(in: .whitespaces).split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                html += "<tr>" + row.map { "<td>" + inlineMarkdown($0) + "</td>" }.joined() + "</tr>"
                index += 1
            }
            html += "</tbody></table>"
            continue
        }
        paragraph.append(line)
        index += 1
    }
    if inCode { html += "<pre><code>" + escapeHtml(codeBuffer) + "</code></pre>" }
    flushParagraph(); flushList()
    return html
}
