/**
 * 代送意图解析
 *
 * 把一句话变成结构化代送需求：
 *   "帮我给在杭州的妈妈点一份，她不吃辣" 
 *   → { recipient: "妈", city: "杭州", avoidSpicy: true, ... }
 *
 * 不依赖大模型也能工作（规则兜底），
 * 若外部传入 llm 解析结果则优先使用。
 */

export interface SendIntent {
  /** 收餐人称呼，用于卡片文案 */
  recipient: string;
  /** 城市 */
  city?: string;
  /** 详细地址（可选，没有则走门店查询引导用户补充） */
  address?: string;
  /** 忌口关键词 */
  avoid: string[];
  /** 偏好关键词（如：热的、清淡） */
  prefer: string[];
  /** 预算上限（元） */
  budget?: number;
  /** 想对对方说的话 */
  message?: string;
  /** 原始输入 */
  raw: string;
}

/** 常见忌口词典：关键词 → 归一化标签 */
const AVOID_DICT: Record<string, string[]> = {
  辣: ['不吃辣', '少辣', '微辣', '怕辣', '不能吃辣', '忌辣'],
  油炸: ['少油', '不要太油', '油大', '清淡'],
  高糖: ['少糖', '控糖', '无糖', '减糖'],
  牛肉: ['不吃牛肉', '忌牛肉'],
  鸡肉: ['不吃鸡', '忌鸡肉'],
  生冷: ['不吃凉', '胃不好', '肠胃'],
};

/** 城市名（常见，可扩充） */
const CITIES = [
  '北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆', '武汉',
  '西安', '苏州', '天津', '长沙', '郑州', '青岛', '宁波', '厦门', '福州',
  '合肥', '济南', '大连', '沈阳', '昆明', '无锡', '佛山', '东莞',
];

/** 收餐人称呼 */
const RECIPIENT_PATTERNS = [
  /(?:给|送给|点给)([\u4e00-\u9fa5]{1,8}?)(?:点|送|买|订)/,
  /(?:给|帮)([\u4e00-\u9fa5]{1,8}?)(?:点|送|买|订)/,
  /(?:给|帮)([\u4e00-\u9fa5]{1,8}?)$/,
];

/** 亲属/关系称呼，用于从「杭州的妈妈」里剥出「妈妈」 */
const KIN_WORDS = [
  '妈妈', '妈', '母亲', '爸爸', '爸', '父亲', '老婆', '媳妇', '妻子',
  '老公', '丈夫', '女朋友', '男朋友', '女友', '男友', '女儿', '儿子',
  '爷爷', '奶奶', '外婆', '外公', '姥姥', '姥爷', '哥哥', '姐姐',
  '弟弟', '妹妹', '室友', '同事', '同学', '朋友', '哥们', '姐妹', '闺蜜', '宝宝',
];

/**
 * 从一段候选文本里提取真正的收餐人称呼。
 * 「杭州的妈妈」→「妈妈」；「我妈」→「妈」
 */
function extractRecipient(candidate: string): string | null {
  let s = candidate
    .replace(/^(在|我的|我|于|位于)/, '')
    .replace(/(那边|那儿|这里|当地|家的?)$/, '');

  // 已是亲属称呼，直接返回
  if (KIN_WORDS.includes(s)) return s;

  // 剔除城市名
  for (const c of CITIES) s = s.split(c).join('');

  // 「的妈妈」这类结构：取最后一个亲属词
  for (const k of KIN_WORDS) {
    if (s.endsWith(k)) return k;
  }
  // 「妈妈家」→「妈妈」
  for (const k of KIN_WORDS) {
    if (s.includes(k)) return k;
  }

  s = s.replace(/^的/, '').trim();
  return s.length >= 1 && s.length <= 6 ? s : null;
}

export function parseIntent(raw: string, llmResult?: Partial<SendIntent>): SendIntent {
  if (llmResult && llmResult.recipient) {
    return {
      recipient: llmResult.recipient,
      city: llmResult.city,
      address: llmResult.address,
      avoid: llmResult.avoid ?? [],
      prefer: llmResult.prefer ?? [],
      budget: llmResult.budget,
      message: llmResult.message,
      raw,
    };
  }

  // 收餐人
  let recipient = 'TA';
  for (const p of RECIPIENT_PATTERNS) {
    const m = raw.match(p);
    if (m?.[1]) {
      const r = extractRecipient(m[1]);
      if (r) {
        recipient = r;
        break;
      }
    }
  }

  // 城市
  let city: string | undefined;
  for (const c of CITIES) {
    if (raw.includes(c)) {
      city = c;
      break;
    }
  }
  // "在XX的妈妈" 这类结构
  if (!city) {
    const m = raw.match(/在([\u4e00-\u9fa5]{2,4}?)(?:的|那边|那儿|这里)/);
    if (m?.[1] && CITIES.includes(m[1])) city = m[1];
  }

  // 忌口
  const avoid: string[] = [];
  for (const [tag, words] of Object.entries(AVOID_DICT)) {
    if (words.some((w) => raw.includes(w)) || raw.includes(tag)) avoid.push(tag);
  }

  // 偏好
  const prefer: string[] = [];
  if (/热|暖/.test(raw)) prefer.push('热的');
  if (/清淡/.test(raw)) prefer.push('清淡');

  // 预算
  let budget: number | undefined;
  const bm = raw.match(/(\d{2,4})\s*(?:元|块)?\s*(?:以内|以下|预算)/) ?? raw.match(/预算\s*(\d{2,4})/);
  if (bm?.[1]) budget = Number(bm[1]);

  // 留言
  let message: string | undefined;
  const mm = raw.match(/[说写带](?:一句|上)?[:：]?\s*[「"']([^」"']+)[」"']/);
  if (mm?.[1]) message = mm[1];

  return { recipient, city, address: undefined, avoid, prefer, budget, message, raw };
}

/** 生成默认留言（没有明确留言时按关系给一句） */
export function defaultMessage(intent: SendIntent): string {
  const r = intent.recipient;
  if (/妈|母亲/.test(r)) return '天冷了，吃点热的。别省着。';
  if (/爸|父亲/.test(r)) return '注意身体，别老凑合。';
  if (/老婆|媳妇|女朋友|宝宝/.test(r)) return '记得吃饭，别熬太晚。';
  if (/老公|男朋友/.test(r)) return '加班辛苦了，吃点好的。';
  if (/室友|同学|朋友|哥们|姐妹/.test(r)) return '今天你辛苦了，这份我请。';
  return '不用回我，趁热吃。';
}

/** 是否命中忌口（用于筛餐） */
export function conflictsWithAvoid(itemName: string, avoid: string[]): boolean {
  const spicyWords = ['辣', '麻辣', '香辣', '椒麻', '藤椒'];
  const friedWords = ['炸', '脆薯', '鸡块', '麦乐鸡'];
  const sugarWords = ['可乐', '雪碧', '甜', '派', '圣代', '新地'];
  const beefWords = ['牛', '巨无霸'];

  for (const a of avoid) {
    if (a === '辣' && spicyWords.some((w) => itemName.includes(w))) return true;
    if (a === '油炸' && friedWords.some((w) => itemName.includes(w))) return true;
    if (a === '高糖' && sugarWords.some((w) => itemName.includes(w))) return true;
    if (a === '牛肉' && beefWords.some((w) => itemName.includes(w))) return true;
  }
  return false;
}