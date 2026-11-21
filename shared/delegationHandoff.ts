/** 将卡片里的补充要求和确定的委派编号一起交给小驳。 */
export function delegationFollowUp(id: string, text: string): string {
  return `继续委派（${id}）：${text.trim()}`;
}

/** 卡片发出的消息含明确编号；模型漏填续作编号时仍沿用原委派。 */
export function delegationFollowUpId(text: string | undefined): string | undefined {
  return text?.match(/^继续委派（(d_[a-z0-9]+)）：[\s\S]*\S/u)?.[1];
}

/** 确认恢复中断时沿用服务端保存的原始要求。 */
export function delegationRecoveryPrompt(id: string): string {
  return `恢复委派（${id}）`;
}

export function delegationRecoveryId(text: string | undefined): string | undefined {
  return text?.trim().match(/^恢复委派（(d_[a-z0-9]+)）$/u)?.[1];
}
