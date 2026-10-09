/**
 * 心意卡片生成
 *
 * 产出：一张可截图分享的终端卡片 + 一份 Markdown 文本，
 * 用于发微信 / 朋友圈 / 小红书。
 */

import type { SendIntent } from './intent.js';

export interface CardData {
  intent: SendIntent;
  storeName: string;
  eta?: string;
  items: Array<{ name: string; qty: number; price: number }>;
  total: number;
  saved?: number;
  message: string;
  orderNo?: string;
}

/** 终端卡片（演示用，观感直接影响 Star 转化） */
export function renderTerminalCard(d: CardData): string {
  const W = 46; // 框内可用显示宽度
  const row = (s: string) => `│${fit(s, W)}│`;
  const sep = () => `├${'─'.repeat(W)}┤`;
  const lines: string[] = [];

  lines.push(`┌${'─'.repeat(W)}┐`);
  lines.push(row('  🍟  麦麦代送 · 心意卡片'));
  lines.push(sep());
  lines.push(row(`  送给：${d.intent.recipient}`));
  lines.push(row(`  来自：${d.storeName}${d.eta ? ` · ${d.eta}` : ''}`));
  lines.push(sep());

  for (const it of d.items) {
    const left = `  ${it.name} ×${it.qty}`;
    const right = `¥${it.price.toFixed(2)}`;
    const gap = W - displayWidth(left) - displayWidth(right);
    lines.push(row(left + ' '.repeat(Math.max(1, gap)) + right));
  }

  lines.push(sep());
  if (d.saved && d.saved > 0) {
    lines.push(row(`  已用券省下：¥${d.saved.toFixed(2)}`));
  }
  lines.push(row(`  实付：¥${d.total.toFixed(2)}`));
  lines.push(sep());
  lines.push(row('  💬 想对你说：'));
  for (const chunk of wrap(d.message, W - 4)) {
    lines.push(row(`  ${chunk}`));
  }
  if (d.orderNo) {
    lines.push(sep());
    lines.push(row(`  订单号：${d.orderNo}`));
  }
  lines.push(`└${'─'.repeat(W)}┘`);

  return lines.join('\n');
}

/** Markdown 版（便于贴到社交平台） */
export function renderMarkdownCard(d: CardData): string {
  const itemLines = d.items
    .map((i) => `| ${i.name} | ×${i.qty} | ¥${i.price.toFixed(2)} |`)
    .join('\n');

  return `# 🍟 麦麦代送 · 给「${d.intent.recipient}」的一份

> ${d.message}

| 餐品 | 数量 | 金额 |
|---|---:|---:|
${itemLines}

**实付 ¥${d.total.toFixed(2)}**${d.saved ? `（已省 ¥${d.saved.toFixed(2)}）` : ''}

📍 ${d.storeName}${d.eta ? ` · ${d.eta}` : ''}
${d.orderNo ? `🧾 订单号 ${d.orderNo}` : ''}

*由 MCD Send-a-Meal 生成 · 基于麦当劳 MCP*
`;
}

/** 终端显示宽度：CJK 与 emoji 算 2 格 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 汉字
      (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
      (cp >= 0xff00 && cp <= 0xffef) || // 全角
      (cp >= 0x1f300 && cp <= 0x1faff) || // emoji 主区
      cp === 0x2764 || // ❤
      cp === 0x2b50 // ⭐
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** 把一行内容补到固定显示宽度，保证边框竖直对齐 */
function fit(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (displayWidth(cur + ch) > width) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}