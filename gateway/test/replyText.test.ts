import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { repairReplyText } from "../../shared/replyText.ts";

describe("回复里的孤立점", () => {
  test("中文开头的点去掉，韩文词里的点留着", () => {
    assert.equal(repairReplyText("점来啦！我已经把这张图片同步存好了"), "来啦！我已经把这张图片同步存好了");
    assert.equal(repairReplyText("점已经把这两个坑记下来了"), "已经把这两个坑记下来了");
    assert.equal(repairReplyText("점점重新给你画好啦"), "重新给你画好啦");
    assert.equal(repairReplyText("这次점수很高"), "这次점수很高");
    assert.equal(repairReplyText("점"), "점");
    assert.equal(repairReplyText("점" + "来啦"), "来啦");
    assert.equal(repairReplyText("这次점") + repairReplyText("수很高"), "这次점수很高");
    assert.equal(repairReplyText("점점 좋아"), "점점 좋아");
    assert.equal(repairReplyText("10점"), "10점");
    assert.equal(repairReplyText("좋은 점"), "좋은 점");
    assert.equal(repairReplyText("点来啦"), "点来啦");
  });
});