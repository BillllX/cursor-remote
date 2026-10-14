import Foundation
import Observation
import Photos
import UIKit

extension ChatStore {
    // MARK: 单颗 undo

    /// 有可还原的最近一轮（对齐网页：undo 作用于最后一轮）
    var canUndo: Bool {
        canUndo(activeId)
    }

    func canUndo(_ chatId: String) -> Bool {
        guard !isBusy(chatId), let chat = chatSession(chatId) else { return false }
        return chat.turns.contains { !$0.running && !$0.queued }
    }

    func undoLast(chatId: String? = nil) {
        let targetId = chatId ?? activeId
        guard canUndo(targetId) else { return }
        send(.undo(chatId: targetId))
    }

    func keepTurnFiles(_ turnId: String, chatId: String? = nil) {
        let targetId = chatId ?? activeId
        guard let chat = chatSession(targetId), chat.turns.contains(where: { $0.id == turnId }) else { return }
        markTurnReview(turnId, review: "accepted", onlyEmpty: true, chatId: targetId)
    }

    /// 发出还原后先挂「还原中」，等 undone/restored 回执确认这一轮的文件真回去了才标 rejected
    func restoreTurnFiles(_ turnId: String, chatId: String? = nil) {
        let targetId = chatId ?? activeId
        guard !restoringTurnIds.contains(turnId) else { return }
        guard let chat = chatSession(targetId), let turn = chat.turns.first(where: { $0.id == turnId }) else { return }
        // 绝对路径和 files 里的相对路径归一后可能重合：去重保序，revert_file 一个路径只发一次
        var paths: [String] = []
        for path in turn.reviewPaths.map({ relToCwd($0, chatId: targetId) }) where !path.isEmpty && !paths.contains(path) {
            paths.append(path)
        }
        guard !paths.isEmpty else { return }
        let last = chat.turns.reversed().first { !$0.queued && !$0.reviewPaths.isEmpty }
        let viaUndo = last?.id == turnId
        restoringTurnIds.insert(turnId)
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.restoreWaits[turnId] != nil else { return }
            self.restoreWaits[turnId] = nil
            self.restoringTurnIds.remove(turnId)
            self.flash("还原没有收到回音，看一下文件再决定要不要重试")
        }
        restoreWaits[turnId] = RestoreWait(
            chatId: chat.id,
            paths: Set(paths),
            viaUndo: viaUndo,
            remaining: viaUndo ? 1 : paths.count,
            timeout: timeout
        )
        if viaUndo {
            send(.undo(chatId: chat.id))
        } else {
            for path in paths {
                send(.revertFile(chatId: chat.id, path: path))
            }
        }
    }

    /// undone / restored / error 回执对账还原等待。restoredCheckpoint=true 表示 undo 落到了检查点还原（不带 paths）
    func settleRestore(chatId: String, paths: [String], error: String?, restoredCheckpoint: Bool = false) {
        let candidates = restoreWaits.filter { $0.value.chatId == chatId }
        guard !candidates.isEmpty else { return }
        let normalized = Set(paths.map { relToCwd($0, chatId: chatId) }.filter { !$0.isEmpty })
        let matched = candidates.first { !$0.value.paths.isDisjoint(with: normalized) }
        let fallback = candidates.first { restoredCheckpoint ? $0.value.viaUndo : true }
        guard let entry = matched ?? fallback else { return }
        let turnId = entry.key
        let wait = entry.value
        func finish(_ failure: String?) {
            wait.timeout?.cancel()
            restoreWaits[turnId] = nil
            restoringTurnIds.remove(turnId)
            if let failure {
                flash("没能还原：\(failure)")
            } else {
                markTurnReview(turnId, review: "rejected", onlyEmpty: false, chatId: wait.chatId)
            }
        }
        if let error, !error.isEmpty {
            finish(error)
            return
        }
        if restoredCheckpoint {
            finish(nil)
            return
        }
        var next = wait
        next.remaining -= 1
        if matched != nil { next.hit = true }
        if next.remaining > 0 {
            restoreWaits[turnId] = next
            return
        }
        finish(next.hit ? nil : "没有可还原的改动")
    }

    func markTurnReview(_ turnId: String, review: String, onlyEmpty: Bool, chatId: String? = nil) {
        guard let index = chats.firstIndex(where: { $0.id == (chatId ?? activeId) }) else { return }
        var chat = chats[index]
        var reviews: [[String: JSONValue]] = []
        var untaggable = false
        chat.turns = chat.turns.map { turn in
            guard turn.id == turnId else { return turn }
            let ids = turn.reviewCallIds
            if ids.isEmpty, !turn.files.isEmpty { untaggable = true }
            var next = turn
            next.tools = turn.tools.map { tool in
                var copy = tool
                guard ids.contains(copy.callId) else { return copy }
                if onlyEmpty, !(copy.review ?? "").isEmpty { return copy }
                copy.review = review
                reviews.append(["callId": .string(copy.callId), "review": .string(review)])
                return copy
            }
            return next
        }
        chats[index] = chat
        bodySegs[chat.id] = nil // 本地写了保留/还原标记，正文与段哈希不再对应
        if untaggable { localTurnReviews[turnId] = review }
        guard !reviews.isEmpty else { return }
        send(.toolReview(chatId: chat.id, turnId: turnId, reviews: reviews))
    }

    func refreshCheckpoints(chatId: String? = nil) {
        let targetId = chatId ?? activeId
        guard client.isOpen, targetId != "boot" else { return }
        send(.listCheckpoints(chatId: targetId))
    }

    func restoreCheckpoint(_ id: String, chatId: String? = nil) {
        let targetId = chatId ?? activeId
        guard client.isOpen else { return }
        guard !isBusy(targetId) else {
            flash("等当前这条跑完再还原")
            return
        }
        send(.restore(chatId: targetId, checkpointId: id))
    }
}
