import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("iOS 流量优化 P0 契约", () => {
  test("full-jitter 退避封顶 60 秒，稳定连接后才清零", () => {
    const ceiling = (failures: number) => (failures <= 0 ? 0 : Math.min(60, 2 ** Math.min(failures - 1, 6)));
    assert.deepEqual(
      Array.from({ length: 8 }, (_, index) => ceiling(index + 1)),
      [1, 2, 4, 8, 16, 32, 60, 60],
    );

    const client = read("ios/Jiebo/Jiebo/Gateway/GatewayClient.swift");
    assert.match(client, /GatewayRetryPolicy\.delay\(failureCount: failureCount, random: Double\.random/);
    assert.match(client, /GatewayRetryPolicy\.stableResetAfter/);
    assert.doesNotMatch(client, /withTimeInterval: 1\.5/);
    assert.match(client, /guard !closedByUser, networkCost\.reachable, task == nil/);
  });

  test("路径恢复、多 Scene 边沿和权限上报遵守统一闸门", () => {
    const policies = read("ios/Jiebo/Jiebo/Gateway/GatewayPolicies.swift");
    const app = read("ios/Jiebo/Jiebo/JieboApp.swift");
    const device = read("ios/Jiebo/Jiebo/Device/DeviceBridgeCoordinator.swift");
    const project = read("ios/Jiebo/Jiebo.xcodeproj/project.pbxproj");
    const client = read("ios/Jiebo/Jiebo/Gateway/GatewayClient.swift");
    assert.match(policies, /NWPathMonitor/);
    assert.equal((project.match(/NETP00101 \/\* GatewayPolicies\.swift \*\//g) || []).length, 3);
    assert.equal((project.match(/NETP00201 \/\* GatewayPolicies\.swift in Sources \*\//g) || []).length, 2);
    assert.match(policies, /becameActive: !wasActive && anyActive/);
    assert.match(app, /guard change\.becameActive else \{ return \}/);
    assert.match(app, /requestAssistant|store\.appBecameActive\(\)/);
    assert.match(app, /refresh\(forceReport: false\)/);
    assert.match(device, /refresh\(forceReport: false\)/);
    assert.match(app, /if unlocked \{ deviceBridge\.permissionStore\.refresh\(forceReport: true\) \}/);
    assert.match(policies, /case backgroundTrafficRestored/);
    assert.match(client, /transition == \.backgroundTrafficRestored[\s\S]*onBackgroundTrafficRestored\?\(\)/);
    assert.doesNotMatch(client, /transition == \.backgroundTrafficRestored[\s\S]{0,300}cancel\(with:/);
  });

  test("IM 成功时间、受限路径补齐和 WS 类型计量已接线", () => {
    const im = read("ios/Jiebo/Jiebo/Session/IM/ImStore.swift");
    const client = read("ios/Jiebo/Jiebo/Gateway/GatewayClient.swift");
    const policies = read("ios/Jiebo/Jiebo/Gateway/GatewayPolicies.swift");
    assert.match(im, /lastListSuccessAt = Date\(\)/);
    assert.doesNotMatch(im, /lastRefreshAt/);
    assert.match(im, /shouldReduceBackgroundTraffic == true, convId != visibleConvId/);
    assert.match(im, /func open\(convId: String\)[\s\S]*catchUp\(convId: convId\)/);
    assert.match(client, /trafficMeter\.record\(direction: \.outbound/);
    assert.match(client, /trafficMeter\.record\(direction: \.inbound/);
    assert.match(policies, /不保留正文/);
  });

  test("mobile compact、文件索引新鲜度和 iPhone 自动拉取闸门已接线", () => {
    const protocol = read("ios/Jiebo/Jiebo/Gateway/Protocol.swift");
    const composer = read("ios/Jiebo/Jiebo/Session/ChatStore+Composer.swift");
    const handle = read("ios/Jiebo/Jiebo/Session/ChatStore+Handle.swift");
    const cover = read("ios/Jiebo/Jiebo/Views/FileBrowserCover.swift");
    const sheet = read("ios/Jiebo/Jiebo/Views/FileBrowserSheet.swift");
    assert.match(protocol, /"mobile_compact_v1"/);
    assert.match(composer, /assistantOnly, !userInitiated/);
    assert.match(composer, /FileIndexFreshnessPolicy\.isFresh/);
    assert.match(composer, /Task\.sleep\(for: \.milliseconds\(350\)\)/);
    assert.match(composer, /if reqId == nil[\s\S]*fileIndexFallbackTasks/);
    assert.match(handle, /case \.toolCompleted[\s\S]*scheduleFileIndexFallback/);
    assert.match(handle, /case \.fileChanged[\s\S]*scheduleFileIndexFallback/);
    assert.match(cover, /requestFileIndex\(userInitiated: true\)/);
    assert.match(sheet, /requestFileIndex\(chatId: chatId, userInitiated: true\)/);
  });

  test("受限历史、revision 游标和 deferred 水合闭环已接线", () => {
    const protocol = read("ios/Jiebo/Jiebo/Gateway/Protocol.swift");
    const load = read("ios/Jiebo/Jiebo/Session/ChatStore+TurnsLoad.swift");
    const handle = read("ios/Jiebo/Jiebo/Session/ChatStore+Handle.swift");
    const models = read("ios/Jiebo/Jiebo/Session/ChatModels.swift");
    const view = read("ios/Jiebo/Jiebo/Views/TurnView.swift");
    assert.match(protocol, /"deferred_turn"/);
    assert.match(protocol, /chatRev: object\["chatRev"\]\?\.int/);
    assert.match(handle, /shouldReduceBackgroundTraffic[\s\S]*PartialHistory/);
    assert.match(load, /partial\.chatRev == chatRevs\[chatId\]/);
    assert.match(load, /GatewayConfig\.stateTurnURL/);
    assert.match(load, /payload\.chatRev == requestedRev/);
    assert.match(models, /var deferred: Bool/);
    assert.match(models, /turnsComplete, !turns\.contains/);
    assert.match(view, /加载完整内容/);
    assert.match(handle, /ChatPageRevisionPolicy\.action/);
    assert.doesNotMatch(handle, /action != \.accept[\s\S]{0,500}chatRevs\[chatId\]\s*=\s*pageRev/);
  });

  test("确认重置、租约复验和费用恢复队列都有静态闭环", () => {
    const lifecycle = read("ios/Jiebo/Jiebo/Session/ChatStore+Lifecycle.swift");
    const composer = read("ios/Jiebo/Jiebo/Session/ChatStore+Composer.swift");
    const im = read("ios/Jiebo/Jiebo/Session/IM/ImStore.swift");
    const imComposer = read("ios/Jiebo/Jiebo/Views/IM/ChatComposer.swift");
    const thumbs = read("ios/Jiebo/Jiebo/Session/ThumbnailStore.swift");

    assert.match(lifecycle, /func resetTenantSession\(\) \{[\s\S]*cancelUploadConfirmations\(\)/);
    assert.match(composer, /func cancelUploadConfirmations\(\)[\s\S]*resume\(returning: false\)/);
    assert.match(composer, /uploadConfirmationGeneration == generation/);
    assert.match(composer, /guard uploadLeaseIsCurrent[\s\S]*Uploader\.upload[\s\S]*guard uploadLeaseIsCurrent/);
    assert.match(composer, /let tokenAtStart[\s\S]*token: tokenAtStart/);
    assert.match(imComposer, /guard im\.tenant == batch\.tenant, convId == batch\.convId/);
    assert.match(lifecycle, /resumeTrafficDeferredWork[\s\S]*backgroundTrafficRestored/);
    assert.match(im, /func backgroundTrafficRestored\(\)[\s\S]*deferredCatchUp/);
    assert.match(thumbs, /func backgroundTrafficRestored\(\)[\s\S]*ThumbDisk\.load/);
  });

  test("移动数据三档、缓存优先、点按放行和上传档位已接线", () => {
    const policies = read("ios/Jiebo/Jiebo/Gateway/GatewayPolicies.swift");
    const media = read("ios/Jiebo/Jiebo/Session/IM/ImMedia.swift");
    const thumbs = read("ios/Jiebo/Jiebo/Session/ThumbnailStore.swift");
    const thread = read("ios/Jiebo/Jiebo/Views/IM/ChatThreadView.swift");
    const imComposer = read("ios/Jiebo/Jiebo/Views/IM/ChatComposer.swift");
    const cards = read("ios/Jiebo/Jiebo/Views/FileCardView.swift");
    const settings = read("ios/Jiebo/Jiebo/Views/Phone/MenuScreens.swift");
    const composer = read("ios/Jiebo/Jiebo/Session/ChatStore+Composer.swift");
    const share = read("ios/Jiebo/Jiebo/Auth/ImShareBridge.swift");

    for (const value of ["standard", "dataSaver", "unrestricted"]) {
      assert.match(policies, new RegExp(`case ${value}`));
    }
    assert.match(policies, /else \{ return \.standard \}/);
    assert.match(settings, /个人热点或系统低数据模式/);
    assert.ok(media.indexOf("FileManager.default.fileExists") < media.indexOf("guard allowsNetwork"));
    assert.match(thumbs, /ThumbDisk\.load[\s\S]*if let cached[\s\S]*scheduleNetwork\(job/);
    assert.match(thread, /图片已省流量[\s\S]*点按加载/);
    assert.match(cards, /case \.delayed:[\s\S]*点按加载/);
    assert.match(thumbs, /func loadOnce[\s\S]*userInitiated: true/);
    assert.match(composer, /size > MobileMediaPolicy\.largeShareRetryBudget[\s\S]*confirmUpload/);
    assert.match(imComposer, /sizes\.contains[\s\S]*largeShareRetryBudget[\s\S]*ImLargeImageBatch/);
    assert.match(policies, /maxPixel: 1280, jpegQuality: 0\.65/);
    assert.match(
      share,
      /candidate\.attempts > 0, bodyBytes > 5 \* 1024 \* 1024[\s\S]*allowsConstrainedNetworkAccess = false/,
    );
  });
});
