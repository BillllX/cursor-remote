import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("iOS P6 静态契约", () => {
  test("AssistantCaptureBridge 在两个 target 四重登记且队列有裁剪", () => {
    const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
    assert.match(project, /P6000101 \/\* AssistantCaptureBridge\.swift \*\//);
    assert.match(project, /P6000201 \/\* AssistantCaptureBridge\.swift in Sources \*\//);
    assert.match(project, /P6000202 \/\* AssistantCaptureBridge\.swift in Sources \*\//);
    assert.equal((project.match(/P6000201 \/\* AssistantCaptureBridge\.swift in Sources \*\//g) || []).length, 2);
    assert.equal((project.match(/P6000202 \/\* AssistantCaptureBridge\.swift in Sources \*\//g) || []).length, 2);

    const bridge = read("ios/Jiebo/Jiebo/Auth/AssistantCaptureBridge.swift");
    assert.match(bridge, /maximumItems = 40/);
    assert.match(bridge, /maximumAge: TimeInterval = 7 \* 24 \* 60 \* 60/);
    assert.match(bridge, /\.suffix\(maximumItems\)/);
    assert.doesNotMatch(bridge, /Keychain|Bearer|token/i);
  });

  test("旧 IM snapshot 可缺少助理 URL，原聊天分享入口仍保留", () => {
    const bridge = read("ios/Jiebo/Jiebo/Auth/ImShareBridge.swift");
    assert.match(bridge, /var assistantIngestURL: String\?/);
    assert.match(bridge, /var assistantUploadURL: String\?/);
    assert.match(bridge, /func enqueueJSON\(/);
    assert.match(bridge, /func enqueueUpload\(/);
    assert.match(bridge, /func enqueueAssistantJSON\(/);
    assert.match(bridge, /func enqueueAssistantUpload\(/);
  });

  test("App Intents 与 drain 均登记主 target", () => {
    const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
    assert.equal((project.match(/P6000203 \/\* JieboAppIntents\.swift in Sources \*\//g) || []).length, 2);
    assert.equal((project.match(/P6000204 \/\* AssistantCaptureDrain\.swift in Sources \*\//g) || []).length, 2);
    const intents = read("ios/Jiebo/Jiebo/AppIntents/JieboAppIntents.swift");
    assert.match(intents, /struct AskJieboIntent: AppIntent/);
    assert.match(intents, /struct CaptureForJieboIntent: AppIntent/);
    assert.match(intents, /struct OpenJieboVoiceIntent: AppIntent/);
    assert.match(intents, /struct JieboAppShortcuts: AppShortcutsProvider/);
  });
});
