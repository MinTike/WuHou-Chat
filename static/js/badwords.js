/* ============================================================
   客户端违规词检测

   聊天正文 / 动态正文是加密的，服务端持有托管密钥可解密，
   因此词库由 `/api/meta/badwords` 下发，在浏览器里做前置检测。
   归一化逻辑必须与 app/core/moderation.py 保持一致，否则会出现
   "服务端能拦、客户端拦不住"（或反之）的错觉。
   ============================================================ */
import { api } from './api.js';

const CACHE_KEY = 'wuhou.badwords';

// 与服务端 VARIANTS 对齐：谐音 / 形近 / 拆字还原
// 注意：不收录 你妈/麻痹/鸡婆/2b —— 它们同时也是「你妈妈」「小儿麻痹」「2B铅笔」等正常表达，会误伤
const VARIANTS = {
  '沙比': '傻逼', '傻b': '傻逼', '傻bī': '傻逼', '傻批': '傻逼', '傻屁': '傻逼',
  '煞笔': '傻逼', '撒比': '傻逼', '傻13': '傻逼', '二逼': '傻逼',
  '尼马': '尼玛', '泥马': '尼玛', '尼美': '尼玛',
  '草尼马': '草泥马', '艹泥马': '草泥马', '草泥马戈壁': '草泥马',
  '沙雕': '沙雕', '脑残': '智障', '智涨': '智障', '弱支': '弱智',
  '滚粗': '滚蛋', '狗东西': '狗东西', '狗日的': '狗东西',
  '婊子': '婊子', '表子': '婊子',
  '赌搏': '赌博', '堵博': '赌博', '读博彩': '博彩', '波菜': '博彩',
  '毒pin': '毒品', '吸毒贩毒': '吸毒', '冰du': '冰毒',
  '炸yao': '炸药', '枪zhi': '枪支',
  '咋骗': '诈骗', '欺炸': '诈骗', '洗qian': '洗钱',
  '色q': '色情', '淫wei': '淫秽', '黄片': '色情', '毛片': '色情',
  'f*ck': 'fuck', 'f u c k': 'fuck', 'fvck': 'fuck', 'fuk': 'fuck',
  'sh1t': 'shit', 'b1tch': 'bitch', 'azz': 'asshole', 'a-hole': 'asshole',
};

// 保留：数字 / 小写字母 / 中日韩统一表意文字（其余符号、空白、标点剥离）
const KEEP = /[^0-9a-z㐀-鿿]/g;
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '$': 's', '@': 'a' };

let WORDS = [];
let NORM = new Map();   // 词 → 归一化形态。词库上千条，必须在换库时算一次，不能每次检测现算
let VERSION = 0;
let ACTION = 'mask';
let loaded = false;
let loading = null;

/** 重建归一化索引（词库变化后必须调用） */
function reindex() {
  NORM = new Map();
  for (const w of WORDS) {
    const n = normalize(w);
    if (n) NORM.set(w, n);
  }
}

function normalize(text) {
  let t = String(text || '').normalize('NFKC').toLowerCase();
  if (VARIANTS[t]) t = VARIANTS[t];
  for (const k of Object.keys(VARIANTS)) {
    if (t.includes(k)) t = t.split(k).join(VARIANTS[k]);
  }
  t = t.replace(KEEP, '');
  return t.split('').map((c) => LEET[c] || c).join('');
}

/** 折叠叠字：`傻傻逼` → `傻逼` */
function collapse(text) {
  return String(text || '').replace(/(.)\1+/g, '$1');
}

/** 同一词形的多种写法（傻逼 / 傻13 / 沙比 / 2b）只保留一个代表，避免提示里刷出一长串同义词 */
function dedupe(hits, norm) {
  const best = new Map();
  for (const w of hits) {
    const key = NORM.get(w) || normalize(w);
    const cur = best.get(key);
    if (cur === undefined) { best.set(key, w); continue; }
    const a = norm.includes(w);
    const b = norm.includes(cur);
    if ((a && !b) || (a === b && w.length < cur.length)) best.set(key, w);
  }
  return [...best.values()].sort();
}

/** 命中词列表（空数组 = 未命中） */
export function scan(text) {
  if (!text || !WORDS.length) return [];
  const norm = normalize(text);
  let hits = WORDS.filter((w) => w && norm.includes(w));
  if (!hits.length) {
    const folded = collapse(norm);
    if (folded !== norm) hits = WORDS.filter((w) => w && folded.includes(w));
  }
  if (!hits.length) {
    // 词库自身可能未归一化（管理员新加的词）
    hits = [];
    for (const [w, n] of NORM) if (n && norm.includes(n)) hits.push(w);
  }
  return dedupe([...new Set(hits)], norm);
}

/** 打码：命中的词替换为等长 * */
export function mask(text) {
  let out = String(text || '');
  for (const w of scan(out)) {
    out = out.split(w).join('*'.repeat(Math.max(1, w.length)));
  }
  return out;
}

export function action() { return ACTION || 'mask'; }
export function isReady() { return loaded && WORDS.length > 0; }
export function size() { return WORDS.length; }

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.words)) { WORDS = o.words; VERSION = o.version || 0; ACTION = o.action || 'mask'; reindex(); }
  } catch { /* 缓存损坏忽略 */ }
}

function writeCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ version: VERSION, action: ACTION, words: WORDS })); } catch { /* 忽略 */ }
}

/** 拉取 / 刷新词库。已加载时只做版本比对，不会每次发消息都打接口。 */
export async function ensureWords(force = false) {
  readCache();
  if (!force && loaded && WORDS.length) return WORDS;
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await api.get('/api/meta/badwords');
      if (r && Array.isArray(r.words)) {
        WORDS = r.words.filter(Boolean);
        VERSION = r.version || 0;
        ACTION = r.action || 'mask';
        reindex();
        loaded = true;
        writeCache();
      }
    } catch { loaded = true; }   // 拿不到词库不影响发消息
    loading = null;
    return WORDS;
  })();
  return loading;
}

/** 词库版本变化时静默刷新（管理员改词后最多 60s 内生效） */
let timer = 0;
export function startAutoSync(interval = 60000) {
  if (timer) return;
  const tick = async () => {
    try {
      const r = await api.get('/api/meta/badwords');
      if (r && r.version != null && r.version !== VERSION && Array.isArray(r.words)) {
        WORDS = r.words.filter(Boolean);
        VERSION = r.version;
        ACTION = r.action || ACTION;
        reindex();
        writeCache();
        document.dispatchEvent(new CustomEvent('wuhou:badwords', { detail: VERSION }));
      }
    } catch { /* 忽略 */ }
  };
  tick();
  timer = setInterval(tick, interval);
}

/**
 * 发送前的统一守门：返回 { text, hits, blocked, masked }。
 * 命中时的提示交给调用方，避免本模块反向依赖 ui.js。
 */
export async function guardText(text, field = '') {
  await ensureWords();
  if (!isReady()) return { text, hits: [], blocked: false, masked: false };
  const hits = scan(text);
  if (!hits.length) return { text, hits: [], blocked: false, masked: false };
  reportHit(field, hits);
  const a = action();
  if (a === 'block') return { text, hits, blocked: true, masked: false };
  if (a === 'mask') return { text: mask(text), hits, blocked: false, masked: true };
  return { text, hits, blocked: false, masked: false };   // log：只记录
}

/** 上报命中（供管理端审计；失败静默） */
export function reportHit(field, hits) {
  if (!hits || !hits.length) return;
  api.post('/api/meta/badword-hit', { field, hits: hits.slice(0, 10) }).catch(() => {});
}
