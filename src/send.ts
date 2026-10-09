/**
 * 麦麦代送 · 主流程
 *
 *   定位收餐人 → 选可配送门店 → 按忌口筛餐 → 算价用券 → 展示方案 → 【确认】→ 下单
 *
 * 安全原则：不带 --confirm 时永远是 dry-run，绝不产生真实订单。
 */

import { McdMcpClient } from './mcp-client.js';
import { parseIntent, defaultMessage, conflictsWithAvoid, type SendIntent } from './intent.js';
import { renderTerminalCard, renderMarkdownCard, type CardData } from './card.js';

export interface SendOptions {
  to?: string;
  city?: string;
  address?: string;
  note?: string;
  message?: string;
  budget?: number;
  /** 真正下单的开关，默认 false */
  confirm?: boolean;
  /** 只推荐不涉及地址（用于无地址时的体验） */
  dryRun?: boolean;
  json?: boolean;
}

interface MealItem {
  code?: string;
  name?: string;
  productCode?: string;
  price?: number;
  currentPrice?: number;
  [k: string]: unknown;
}

export async function runSend(opts: SendOptions, client: McdMcpClient): Promise<number> {
  // ---------- 1. 解析意图 ----------
  const raw = [opts.to && `给${opts.to}`, opts.note, opts.message]
    .filter(Boolean)
    .join('，') || '给朋友点一份';
  const intent: SendIntent = parseIntent(raw);
  if (opts.to) intent.recipient = opts.to;
  if (opts.city) intent.city = opts.city;
  if (opts.address) intent.address = opts.address;
  if (opts.budget) intent.budget = opts.budget;
  if (opts.message) intent.message = opts.message;

  log(`🎯 收餐人：${intent.recipient}${intent.city ? `（${intent.city}）` : ''}`);
  if (intent.avoid.length) log(`🚫 忌口：${intent.avoid.join('、')}`);

  // ---------- 2. 时间检查 ----------
  try {
    const t = await client.callTool('now-time-info');
    if (!opts.json) log(`🕐 ${extractTime(t)}`);
  } catch (e) {
    warn(`时间查询跳过：${msg(e)}`);
  }

  // ---------- 3. 地址（代送的关键前置步骤）----------
  let addressId: string | null = null;
  let addressText = intent.address ?? '';
  try {
    const addrs = await client.callTool('delivery-query-addresses');
    // 真实返回结构：{ success, data: { addresses: [ { addressId, contactName, phone, fullAddress } ] } }
    const list = pickArray(addrs, ['addresses', 'data', 'list']) as Array<Record<string, unknown>>;
    if (list.length > 0) {
      const a = list[0];
      addressId = String(a.addressId ?? '');
      addressText = String(a.fullAddress ?? addressText);
      log(`📍 使用收餐人地址：${maskAddress(addressText)}`);
      if (list.length > 1) log(`   （账号下共 ${list.length} 个地址，默认用第一个）`);
    } else {
      log('📍 没有已存的收餐人地址 —— 这正是「代送」的关键前置步骤');
      if (!opts.confirm) {
        log('   （dry-run 不写入地址；正式使用会调用 delivery-create-address）');
      } else if (intent.address) {
        const created = await client.callTool('delivery-create-address', {
          address: intent.address,
        });
        addressId = String((created as Record<string, unknown>)?.addressId ?? '') || null;
        log('   ✅ 已创建收餐人地址');
      } else {
        warn('   缺少地址：正式下单需要 --address 参数');
      }
    }
  } catch (e) {
    warn(`地址查询失败：${msg(e)}`);
  }

  // ---------- 4. 门店（外送 beType=2 需要 addressId）----------
  let storeName = '（未获取到门店）';
  let storeCode: unknown;
  let beCode: unknown;
  try {
    // 真实契约：delivery-query-stores 必填 { beType, addressId }
    const stores = addressId
      ? await client.callTool('delivery-query-stores', { beType: 2, addressId })
      : await client.callTool('query-nearby-stores', {
          beType: 1,
          searchType: intent.city ? 2 : 1,
          city: intent.city,
        });

    // 注意：外送门店接口的 data 直接是数组，不是 data.stores
    const list = pickArray(stores, ['data', 'stores', 'list']) as Array<Record<string, unknown>>;
    if (list.length) {
      // 优先选营业中的门店
      const open = list.filter((s) => s.businessStatus !== false);
      const s = (open[0] ?? list[0]) as Record<string, unknown>;
      storeName = String(s.storeName ?? s.name ?? '附近门店');
      storeCode = s.storeCode ?? s.code ?? s.storeId;
      beCode = s.beCode;
      const status = s.businessStatus === false ? '休息中' : '营业中';
      log(`🏪 门店：${storeName}（${status}）`);
      if (list.length > 1) log(`   附近共 ${list.length} 家可配送门店`);
      if (s.businessStartTime) log(`   营业时间 ${s.businessStartTime}-${s.businessEndTime}`);
    } else {
      warn('没有查到可配送门店，请确认地址或城市');
    }
  } catch (e) {
    warn(`门店查询失败：${msg(e)}`);
  }

  // ---------- 5. 选餐 ----------
  // 真实契约：
  //   query-meals 必填 { storeCode, orderType, beType }；外送(beType=2/5/6)还必须传 beCode
  //   返回 data.categories[].meals[]，但 meals 里只有 code（没有名字！）
  //   名字需要通过 query-meal-detail 逐条查询
  let picked: MealItem[] = [];
  const orderType = addressId ? 2 : 1; // 2=麦乐送，1=到店取
  const beType = addressId ? 2 : 1;
  const mealArgs: Record<string, unknown> = { storeCode, orderType, beType };
  if (beCode) mealArgs.beCode = beCode;

  try {
    const meals = await client.callTool('query-meals', mealArgs);
    const cats = pickArray(meals, ['categories']) as Array<Record<string, unknown>>;

    // 展平所有分类下的餐品 code
    const codes: Array<{ code: string; category: string; tags: string[] }> = [];
    for (const cat of cats) {
      const list = Array.isArray(cat.meals) ? (cat.meals as Array<Record<string, unknown>>) : [];
      for (const m of list) {
        codes.push({
          code: String(m.code ?? ''),
          category: String(cat.name ?? ''),
          tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
        });
      }
    }
    log(`🍔 门店可售 ${codes.length} 款（${cats.length} 个分类）`);

    // 缺名字，需要按 code 查详情补全（挑候选后再查，控制请求量）
    const candidates = codes.slice(0, 60);
    const detailed: MealItem[] = [];
    for (const c of candidates) {
      try {
        const d = await client.callTool('query-meal-detail', { ...mealArgs, code: c.code });
        const data = (d as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        if (data) {
          detailed.push({
            ...data,
            code: c.code,
            productCode: c.code,
            category: c.category,
            tags: c.tags,
          } as MealItem);
        }
      } catch {
        /* 单个餐品失败不影响整体 */
      }
    }

    // 依据分类与名称推断价格（详情接口不一定返回价格，用菜单价兜底）
    const withName = detailed.filter((m) => typeof m.name === 'string' && m.name);
    log(`📋 已补全 ${withName.length} 款餐品信息`);

    const safe = withName.filter((m) => !conflictsWithAvoid(String(m.name ?? ''), intent.avoid));
    const removed = withName.length - safe.length;
    if (removed > 0) log(`🧮 按忌口「${intent.avoid.join('、')}」过滤掉 ${removed} 款`);

    picked = pickCombo(safe, intent);
    if (!picked.length) warn('未能自动配色，请人工选择');
    else log(`✅ 已配色：${picked.map((p) => p.name).join(' + ')}`);
  } catch (e) {
    warn(`餐品查询失败：${msg(e)}`);
  }

  // ---------- 6. 算价 ----------
  let total = picked.reduce((s, p) => s + num(p.currentPrice ?? p.price), 0);
  let saved = 0;
  const items = picked.map((p) => ({
    name: String(p.name ?? '餐品'),
    qty: 1,
    price: num(p.currentPrice ?? p.price),
  }));

  try {
    const coupons = await client.callTool('query-store-coupons', mealArgs);
    const cl = pickArray(coupons, ['coupons', 'data', 'list']);
    if (cl.length) log(`🎫 当前门店可用券 ${cl.length} 张`);

    if (picked.length) {
      // 真实契约：calculate-price 需要 items（不是 products），且含 quantity
      const calc = await client.callTool('calculate-price', {
        ...mealArgs,
        // 注意：套餐不要传 roundList，实测会导致服务器 500；直接传 productCode 即可
        items: picked.map((p) => ({
          productCode: p.productCode ?? p.code,
          quantity: 1,
        })),
      });
      const c = (calc as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
      const src = (c ?? calc) as Record<string, unknown>;
      // ⚠️ 真实契约：价格单位是「分」，需除以 100 转成元
      // data.price = 商品+配送+打包 合计；data.discount = 优惠金额
      const apiTotalFen = num(src?.price ?? src?.payAmount ?? src?.totalPrice);
      const apiSavedFen = num(src?.discount ?? src?.discountAmount);
      if (apiTotalFen > 0) total = apiTotalFen / 100;
      if (apiSavedFen > 0) saved = apiSavedFen / 100;

      // 用真实商品名与单价回填（接口返回的 productList 最权威）
      const pl = Array.isArray(src?.productList)
        ? (src.productList as Array<Record<string, unknown>>)
        : [];

      for (const p of picked) {
        const code = String(p.productCode ?? p.code ?? '');
        // 忽略打包服务费等非餐品条目
        const hits = pl.filter((x) => String(x.productCode) === code);
        const real = hits[0];
        if (real) {
          if (real.productName) p.name = String(real.productName);
          const sub = num(real.subtotal) || num(real.originalSubtotal);
          if (sub > 0) p.currentPrice = sub / 100;
        }
      }

      // 重建卡片条目（名称与单价都以实际下单结果为准）
      items.length = 0;
      for (const p of picked) {
        items.push({
          name: String(p.name ?? '餐品'),
          qty: 1,
          price: num(p.currentPrice ?? p.price),
        });
      }

      log(`💰 实付 ¥${total.toFixed(2)}${saved ? `（省 ¥${saved.toFixed(2)}）` : ''}`);
      if (num(src?.deliveryPrice) > 0) {
        log(`   含配送费 ¥${(num(src?.deliveryPrice) / 100).toFixed(2)}`);
      }
    }
  } catch (e) {
    warn(`算价失败，使用菜单价估算：${msg(e)}`);
  }

  // ---------- 7. 卡片 ----------
  const card: CardData = {
    intent,
    storeName,
    items,
    total,
    saved,
    message: intent.message || defaultMessage(intent),
  };

  const cardText = renderTerminalCard(card);
  const cardMd = renderMarkdownCard(card);

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: !opts.confirm, card, markdown: cardMd }, null, 2));
  } else {
    console.log('\n' + cardText + '\n');
  }

  // ---------- 8. 下单（需显式确认） ----------
  if (!opts.confirm) {
    log('⏸️  dry-run：未下单。确认无误后加 --confirm 正式下单。');
    return 0;
  }

  try {
    // 下单同样需要 beCode（外送场景）
    const order = await client.callTool('create-order', {
      ...mealArgs,
      items: picked.map((p) => ({
        productCode: p.productCode ?? p.code,
        quantity: 1,
      })),
      remark: `代送寄语：${card.message}`,
    });
    const o = ((order as Record<string, unknown>)?.data ?? order) as Record<string, unknown>;
    const orderNo = String(o?.orderNo ?? o?.orderId ?? '');
    const payUrl = String(o?.payUrl ?? o?.paymentUrl ?? o?.payLink ?? '');
    log(`🎉 下单成功${orderNo ? ` 订单号 ${orderNo}` : ''}`);
    if (payUrl) log(`💳 支付链接：${payUrl}`);
    return 0;
  } catch (e) {
    warn(`下单失败：${msg(e)}`);
    return 1;
  }
}

/** 简化配色启发式：主食 + 小食 + 饮品，尽量落在预算内 */
function pickCombo(pool: MealItem[], intent: SendIntent): MealItem[] {
  const name = (m: MealItem) => String(m.name ?? '');
  const price = (m: MealItem) => num(m.currentPrice ?? m.price);

  const main = pool.find((m) => /堡|卷|饭|鸡肉|牛肉/.test(name(m)));
  const side = pool.find((m) => /薯条|玉米|沙拉|鸡块|派/.test(name(m)));
  const drink = pool.find((m) => /可乐|红茶|咖啡|果汁|奶茶|水/.test(name(m)) && m !== main);

  let combo = [main, side, drink].filter(Boolean) as MealItem[];
  if (!combo.length) combo = pool.slice(0, 3);

  if (intent.budget) {
    while (combo.length > 1 && combo.reduce((s, m) => s + price(m), 0) > intent.budget) {
      combo.pop();
    }
  }
  return combo;
}

// ---------- 小工具 ----------

/**
 * 从 MCP 返回里找出数组。
 * 会递归穿透一层 data（真实返回形如 { success, code, data: { addresses: [...] } }
 * 或 { success, code, data: [ ... ] }），这是本客户端最容易踩的坑。
 */
function pickArray(v: unknown, keys: string[], depth = 0): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && depth < 3) {
    const o = v as Record<string, unknown>;
    for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
    // 穿透 data / result 包裹层
    for (const k of ['data', 'result']) {
      if (o[k] !== undefined) {
        const found = pickArray(o[k], keys, depth + 1);
        if (found.length) return found;
      }
    }
  }
  return [];
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 地址脱敏：终端输出时只保留到「区/路」一级，隐去门牌号与小区名，
 * 避免演示录屏或日志泄露收餐人隐私。
 * 例：「XX省XX市XX区XX路123号 某小区1-101」→「XX省XX市XX区XX路…」
 */
function maskAddress(addr: string): string {
  if (!addr) return '（未知地址）';
  const m = addr.match(/^(.{0,10}?(?:区|市|路|街|道|镇))/);
  const head = m?.[1] ?? addr.slice(0, 8);
  return head + '…';
}

function extractTime(t: unknown): string {
  if (typeof t === 'string') return t;
  const o = t as Record<string, unknown>;
  return String(o?.datetime ?? o?.time ?? o?.currentTime ?? JSON.stringify(t).slice(0, 80));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function log(s: string) {
  console.log(s);
}
function warn(s: string) {
  console.warn('⚠️  ' + s);
}