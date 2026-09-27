import Foundation

enum ModelCatalog {
    static let defaultModel = "composer-2.5"
    static let lastModelKey = "jiebo.lastModel"

    struct Item: Identifiable, Hashable {
        var id: String
        var name: String
    }

    struct Group: Identifiable {
        var vendor: String
        var label: String
        var models: [Item]
        var id: String { vendor }
    }

    static func prettyName(_ id: String) -> String {
        let raw = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return "" }
        let lower = raw.lowercased()
        if lower == "auto" || lower == "auto-smart" { return "Auto" }
        if lower == "default" { return "Default" }
        // P11：第三方模型 id 形如 "provider:model"——显示时去掉 provider 前缀
        let withoutProvider = raw.contains(":") ? String(raw.split(separator: ":", maxSplits: 1).last ?? "") : raw
        let stripped = withoutProvider.replacingOccurrences(of: "^cursor-", with: "", options: .regularExpression)
        var out: [String] = []
        let acronyms = ["gpt": "GPT", "glm": "GLM", "ai": "AI", "xai": "xAI"]
        for part in stripped.split(separator: "-").map(String.init) where !part.isEmpty {
            if part.first?.isNumber == true, let last = out.last, last.first?.isNumber == true {
                out[out.count - 1] = "\(last).\(part)"
                continue
            }
            if let acronym = acronyms[part.lowercased()] {
                out.append(acronym)
                continue
            }
            if part.first?.isNumber == true {
                out.append(part)
                continue
            }
            out.append(part.prefix(1).uppercased() + part.dropFirst())
        }
        return out.joined(separator: " ")
    }

    static func label(for id: String) -> String {
        let name = prettyName(id)
        return name.isEmpty ? id : name
    }

    static func vendor(of id: String) -> String {
        let n = id.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if n.isEmpty { return "other" }
        // P11：第三方模型 id 形如 "provider:model"——厂商直接取前缀（如 "minimax:MiniMax-M2" → "minimax"）
        if let colon = n.firstIndex(of: ":") {
            let prefix = String(n.prefix(upTo: colon))
            if !prefix.isEmpty { return prefix }
        }
        if n.contains("grok") || n.hasPrefix("xai") { return "xai" }
        if n == "auto" || n == "auto-smart" || n == "default" || n.hasPrefix("composer") || n == "cursor-small" || n.hasPrefix("cursor-fast") {
            return "cursor"
        }
        if n.contains("claude") || n.contains("sonnet") || n.contains("opus") || n.contains("haiku") || n.contains("fable") {
            return "anthropic"
        }
        if n.hasPrefix("gpt") || n.range(of: #"^o[1-9]"#, options: .regularExpression) != nil || n.hasPrefix("chatgpt") || n.contains("codex") {
            return "openai"
        }
        if n.contains("gemini") || n.contains("gemma") { return "google" }
        if n.hasPrefix("glm") || n.contains("chatglm") || n.hasPrefix("zhipu") { return "zhipu" }
        if n.contains("kimi") || n.contains("moonshot") { return "moonshot" }
        if n.contains("deepseek") { return "deepseek" }
        if n.contains("qwen") || n.hasPrefix("qwq") || n.contains("dashscope") { return "alibaba" }
        if n.contains("llama") || n.contains("meta-llama") { return "meta" }
        if n.contains("mistral") || n.contains("mixtral") || n.contains("codestral") || n.contains("magistral") || n.contains("devstral") {
            return "mistral"
        }
        return "other"
    }

    static func groups(from ids: [String]) -> [Group] {
        let order = ["cursor", "anthropic", "openai", "google", "xai", "zhipu", "moonshot", "deepseek", "alibaba", "meta", "mistral", "minimax", "other"]
        let labels = [
            "cursor": "Cursor",
            "anthropic": "Anthropic",
            "openai": "OpenAI",
            "google": "Google",
            "xai": "xAI",
            "zhipu": "智谱",
            "moonshot": "Moonshot",
            "deepseek": "DeepSeek",
            "alibaba": "阿里",
            "meta": "Meta",
            "mistral": "Mistral",
            "minimax": "MiniMax",
            "other": "其他",
        ]
        var seen = Set<String>()
        var buckets: [String: [Item]] = [:]
        for id in ids {
            let key = id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, !seen.contains(key) else { continue }
            seen.insert(key)
            buckets[vendor(of: key), default: []].append(Item(id: key, name: prettyName(key)))
        }
        var result = order.compactMap { vendor in
            buckets[vendor].flatMap { $0.isEmpty ? nil : Group(vendor: vendor, label: labels[vendor] ?? vendor, models: $0) }
        }
        // P11：providers.json 可配任意第三方前缀——order 之外的 vendor 也要显示，
        // 插到「其他」之前（否则模型在选择器里不可见，Kimi 评审 M3）
        let known = Set(order)
        for vendor in buckets.keys.sorted() where !known.contains(vendor) {
            guard let models = buckets[vendor], !models.isEmpty else { continue }
            let group = Group(vendor: vendor, label: labels[vendor] ?? vendor, models: models)
            if let otherAt = result.firstIndex(where: { $0.vendor == "other" }) {
                result.insert(group, at: otherAt)
            } else {
                result.append(group)
            }
        }
        return result
    }

    static func resolve(preferred: String?, ids: [String], fallback: String) -> String {
        let list = ids.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let want = preferred?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let catalogReady = list.count > 1 || (list.count == 1 && list[0] != defaultModel)
        if !want.isEmpty, !catalogReady || list.contains(want) { return want }
        let next = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        if !next.isEmpty, !catalogReady || list.contains(next) || list.isEmpty { return next }
        return list.first ?? next.nilIfEmpty ?? want.nilIfEmpty ?? defaultModel
    }
}
