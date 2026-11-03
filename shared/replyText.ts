// 个别模型会在汉字前面吐出韩文「점」。只删紧挨在汉字前的「점」。
// 句尾、空格后、数字后的「점」，以及「점수」「점점 좋아」这类韩文，都留着。
// 单独一段「점」先留着：下一段如果是汉字，拼成整句后再删。
const STRAY_JEOM = /점+(?=\p{Script=Han})/gu;

export function repairReplyText(text: string): string {
  if (!text.includes("점")) return text;
  return text.replace(STRAY_JEOM, "");
}
