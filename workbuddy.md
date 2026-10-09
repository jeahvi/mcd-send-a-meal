# WorkBuddy 开发记录 · MCD Send-a-Meal

> 本文件记录使用腾讯 WorkBuddy 辅助开发本项目的对话上下文，
> 用于核验 WorkBuddy 联动活动奖励条件。

## 一、使用说明

本项目在开发过程中使用了 **腾讯 WorkBuddy** 作为辅助开发工具，用途包括：

1. **创意收敛**：在确定选题阶段，用 WorkBuddy 分析市面上已有的麦当劳 MCP 项目分布，辅助判断"代送"方向的空间。
2. **MCP 接入调试**：通过 WorkBuddy 的【自定义连接器】配置麦当劳 MCP Server（`https://mcp.mcd.cn`），逐个验证 Tool 的入参与返回结构。
3. **代码生成与排错**：生成 MCP 客户端的 Streamable HTTP 调用骨架、意图解析规则，并定位响应格式解析问题。

## 二、WorkBuddy 配置方式

在 WorkBuddy 中：左侧边栏【专家·技能·连接器】→【连接器】→【自定义连接器】→【配置 MCP】，填入：

```json
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN"
      }
    }
  }
}
```

> ⚠️ `YOUR_MCP_TOKEN` 需替换为实际 Token（本文件中不包含任何真实 Token）。

配置完成后将 `mcd-mcp` 设为【启用】，即可在对话框内直接让 WorkBuddy 调用麦当劳 MCP 工具。

## 三、开发对话记录

<!--
  说明：此处粘贴从 WorkBuddy 导出的对话上下文。
  建议包含以下关键问答，便于核验：
    1. 选题分析："分析已有麦当劳 MCP 参赛项目的方向分布"
    2. MCP 调试："用 mcd-mcp 查一下杭州文三路附近可配送的门店"
    3. 代码问题："Streamable HTTP 返回 text/event-stream 时如何解析 JSON-RPC 响应"
    4. 意图解析："把'给在杭州的妈妈点一份，她不吃辣'解析成结构化字段"

  导出方式：WorkBuddy 对话界面右上角 → 导出对话 → 粘贴到此处。
-->

### 对话片段示例

**我**：帮我分析一下，基于麦当劳 MCP 开发 Skill，有哪些方向已经被做烂了？

**WorkBuddy**：（调用 mcd-mcp 工具探查能力范围后回答）从工具覆盖看，点餐、营养、优惠券、积分是最容易被想到的方向，这类项目会高度同质化。相对少被使用的能力是：`delivery-create-address`（替他人创建地址）、`party-order-create`（派对预约）、`campaign-calendar`（活动日历）。如果追求差异化，建议围绕"替别人点餐"这一非默认场景切入，因为绝大部分工具都默认服务用户自己。

**我**：mcd-mcp 里我想要"给不在一个城市的人点餐"，调用顺序是什么？

**WorkBuddy**：需要先解决"地址不在本地"的问题，顺序应为：
`now-time-info` → `delivery-query-addresses` →（无地址则）`delivery-create-address` → `delivery-query-stores` → `query-meals` → `list-nutrition-foods` → `query-store-coupons` → `calculate-price` →（用户确认）`create-order`。

**我**：Streamable HTTP 返回的是 text/event-stream，怎么取结果？

**WorkBuddy**：响应可能是 SSE 格式，需要按行扫描以 `data:` 开头的行，取最后一条非空数据行做 `JSON.parse`，同时从响应头 `mcp-session-id` 保存会话 ID，后续请求带上。

---

## 四、WorkBuddy 的使用价值

- **降低了 MCP 调试成本**：无需手写 JSON-RPC 请求即可探索每个 Tool 的真实返回结构，显著缩短了 `calculate-price`、`query-meals` 等工具的对接时间。
- **辅助了选题决策**：通过对 MCP 能力面的梳理，帮助识别出被大量重复选题忽略的 `delivery-create-address` 场景。
- **加速了排错**：SSE 响应解析、会话 ID 处理等问题在 WorkBuddy 中快速定位。

## 五、声明

本文件中不含任何真实 MCP Token、手机号、地址或个人身份信息。所有凭证均通过环境变量注入。