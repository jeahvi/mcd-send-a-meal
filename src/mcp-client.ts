/**
 * 麦当劳 MCP Server 客户端
 *
 * 协议：Streamable HTTP（JSON-RPC 2.0 over HTTP）
 * 地址：https://mcp.mcd.cn
 * 鉴权：Authorization: Bearer <MCD_MCP_TOKEN>
 *
 * 说明：本文件只依赖 Node 内置 fetch，无需额外 SDK，
 *      便于评审直接阅读与运行。
 */

export const MCD_MCP_URL = 'https://mcp.mcd.cn';

export interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McdMcpClient {
  private readonly token: string;
  private readonly url: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(token?: string, url: string = MCD_MCP_URL) {
    const t = token ?? process.env.MCD_MCP_TOKEN;
    if (!t) {
      throw new Error(
        '缺少 MCD_MCP_TOKEN。请复制 .env.example 为 .env.local 并填入你的 Token，' +
          '申请地址：https://open.mcd.cn/mcp'
      );
    }
    this.token = t;
    this.url = url;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  /** 解析响应：可能是纯 JSON，也可能是 SSE 流 */
  private async parseResponse(res: Response): Promise<JsonRpcResponse> {
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const text = await res.text();
    const ctype = res.headers.get('content-type') ?? '';

    if (ctype.includes('text/event-stream') || text.startsWith('event:') || text.includes('\ndata:')) {
      // 取最后一个 data: 行的 JSON
      const datas = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      const last = datas[datas.length - 1];
      if (!last) throw new Error(`MCP 返回了空的事件流: ${text.slice(0, 200)}`);
      return JSON.parse(last) as JsonRpcResponse;
    }
    return JSON.parse(text) as JsonRpcResponse;
  }

  private async rpc(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method };
    if (params !== undefined) body.params = params;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      throw new Error('MCP Token 无效或已过期（401），请到 https://open.mcd.cn/mcp 重新获取');
    }
    if (res.status === 429) {
      throw new Error('触发限流（429）：每分钟上限 600 次，请降低调用频率');
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`MCP 请求失败 ${res.status}: ${t.slice(0, 300)}`);
    }

    const json = await this.parseResponse(res);
    if (json.error) {
      throw new Error(`MCP 错误 ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }

  /** 初始化握手 */
  async initialize(): Promise<unknown> {
    const result = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcd-send-a-meal', version: '0.1.0' },
    });
    // 通知服务端初始化完成（通知无 id，失败可忽略）
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    } catch {
      /* 忽略 */
    }
    return result;
  }

  /** 列出可用工具（用于自检与调试） */
  async listTools(): Promise<Array<{ name: string; description?: string }>> {
    const result = (await this.rpc('tools/list')) as {
      tools?: Array<{ name: string; description?: string }>;
    };
    return result?.tools ?? [];
  }

  /**
   * 调用一个工具
   * @param name 工具名，如 query-meals
   * @param args 工具参数
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as McpToolResult;

    if (result?.isError) {
      const msg = result.content?.map((c) => c.text).filter(Boolean).join('\n') ?? '未知错误';
      throw new Error(`工具 ${name} 执行失败: ${msg}`);
    }

    // 优先返回结构化内容，便于程序处理
    const structured = (result as Record<string, unknown>)?.structuredContent;
    if (structured) return structured;

    const text = result?.content?.map((c) => c.text).filter(Boolean).join('\n');
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** 便捷单例 */
let _client: McdMcpClient | null = null;
export function getClient(token?: string): McdMcpClient {
  if (!_client) _client = new McdMcpClient(token);
  return _client;
}