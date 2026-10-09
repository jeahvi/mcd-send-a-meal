#!/usr/bin/env node
/**
 * CLI 入口：麦麦代送
 *
 * 用法示例：
 *   npm run send -- --to 妈 --city 杭州 --note "不吃辣" --dry-run
 *   npm run send -- --to 妈 --city 杭州 --address "西湖区文三路XX号" --confirm
 *   npm run check                       # 自检：验证 Token 与工具可用性
 */

import { McdMcpClient } from './mcp-client.js';
import { runSend, type SendOptions } from './send.js';
import { parseIntent, defaultMessage } from './intent.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 自检模式
  if (args.check) {
    const client = new McdMcpClient();
    console.log('🔍 正在连接麦当劳 MCP Server ...');
    await client.initialize();
    console.log('✅ 握手成功');
    const tools = await client.listTools();
    console.log(`✅ 可用工具 ${tools.length} 个：`);
    for (const t of tools) console.log(`   · ${t.name}`);
    return 0;
  }

  // 纯解析预览（不需要 Token，方便先看效果）
  if (args['parse-only']) {
    const raw = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ');
    const intent = parseIntent(raw || '给我妈点一份，她不吃辣');
    console.log(JSON.stringify({ ...intent, message: intent.message ?? defaultMessage(intent) }, null, 2));
    return 0;
  }

  const opts: SendOptions = {
    to: args.to as string | undefined,
    city: args.city as string | undefined,
    address: args.address as string | undefined,
    note: args.note as string | undefined,
    message: args.message as string | undefined,
    budget: args.budget ? Number(args.budget) : undefined,
    confirm: Boolean(args.confirm),      // 默认 false → dry-run
    dryRun: Boolean(args['dry-run']) || !args.confirm,
    json: Boolean(args.json),
  };

  const client = new McdMcpClient();
  await client.initialize();
  return runSend(opts, client);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e: unknown) => {
    console.error('❌ ' + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });