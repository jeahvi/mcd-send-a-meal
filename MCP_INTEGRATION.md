# MCP 接入说明 · MCD Send-a-Meal

## 1. 使用的 MCP Server

| 项 | 值 |
|---|---|
| 服务名 | 麦当劳中国 MCP Server |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | Streamable HTTP |
| 鉴权 | 请求头 `Authorization: Bearer <MCD_MCP_TOKEN>` |
| Token 申请 | https://open.mcd.cn/mcp （手机号登录 → 控制台 → 激活） |
| 限流 | 600 次/分钟，超限返回 429 |

## 2. 使用的 Tool 与调用流程

「代送」的核心差异在于：**下单前必须先建立"收餐人地址"**，而普通点餐工具默认用自己家。

### 阶段一 · 定位收餐人

| 步骤 | Tool | 用途 |
|---|---|---|
| 1 | `now-time-info` | 取当前时间，判断门店是否在营业时段 |
| 2 | `delivery-query-addresses` | 查看是否已存有收餐人地址 |
| 3 | `delivery-create-address` | 没有则新建收餐人地址（代送的关键前置步骤） |
| 4 | `delivery-query-stores` | 查该地址附近**可配送**门店 |

### 阶段二 · 选餐

| 步骤 | Tool | 用途 |
|---|---|---|
| 5 | `query-meals` | 拉取门店可售餐品列表 |
| 6 | `list-nutrition-foods` | 取营养数据，用于执行「不吃辣 / 少油 / 低卡」等忌口过滤 |
| 7 | `query-meal-detail` | 查看套餐组成，必要时替换单品 |

### 阶段三 · 算价与用券

| 步骤 | Tool | 用途 |
|---|---|---|
| 8 | `query-store-coupons` | 查当前门店可用券 |
| 9 | `query-my-coupons` | 查账户券，挑出能用的 |
| 10 | `calculate-price` | **精确算出实付总价**，用于给用户二次确认 |

### 阶段四 · 确认与下单

| 步骤 | Tool | 用途 |
|---|---|---|
| 11 | `create-order` | 用户确认后创建订单，返回支付链接 |
| 12 | `query-order` | 下单后轮询订单状态与配送进度 |

### 辅助

| Tool | 用途 |
|---|---|
| `query-nearby-stores` | 没有明确地址时，按城市/地标找店 |
| `campaign-calendar` | 结合当月活动，提示"今天有 1 元薯条"，增加惊喜感 |
| `cancel-order` | 误单时兜底取消 |

## 3. 调用流程（时序）

```
用户一句话
   │
   ├─ 解析意图：收餐人 / 城市 / 地址 / 忌口 / 预算 / 留言
   │
   ├─ now-time-info ──────────────► 是否营业
   ├─ delivery-query-addresses ───► 有地址？
   │      └─ 否 → delivery-create-address
   ├─ delivery-query-stores ──────► 可配送门店
   ├─ query-meals ────────────────► 菜单
   ├─ list-nutrition-foods ───────► 营养/辣度过滤
   ├─ query-store-coupons ────────► 可用券
   ├─ calculate-price ────────────► 实付金额
   │
   ├─ 生成「心意卡片」 + 方案展示
   │
   └─ 【用户确认】──► create-order ──► 支付链接
                         └──► query-order 轮询状态
```

## 4. 业务价值

1. **开辟了 MCP 的新使用场景**：现有工具几乎都是"给自己点"，本项目把 MCP 用于**替他人点餐**，验证了地址创建（`delivery-create-address`）这一低频但关键的链路。
2. **把营养数据用在了情绪场景**：`list-nutrition-foods` 通常被用于减肥，本项目用它替"不吃辣、胃不好"的长辈筛餐，是数据的一种新用法。
3. **两段式确认保证资金安全**：不可逆的 `create-order` 前强制 `calculate-price` 展示实付金额，避免 AI 误下单。
4. **可复用的传送模式**：任何"给别人买东西"的场景（奶茶、鲜花）都能复用本项目的地址+确认框架。

## 5. 安全与合规

- 仓库内**不含任何真实 Token、手机号、地址或个人姓名**
- `mcp-config.example.json` 仅使用 `${MCD_MCP_TOKEN}` 环境变量占位符
- 默认 dry-run，`create-order` 需显式确认
- 不使用任何自动化脚本操纵 Star、不批量注册账号