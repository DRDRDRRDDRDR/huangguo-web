// 黄果解析站 · 共享脚本
//
// 多 Worker 分流：站点部署了 3 个功能完全相同的 Cloudflare Worker，
// 前端按「轮询起点 + 失败自动切换」把请求分散到不同 Worker，
// 单个 Worker 触到免费档每日 10 万次请求上限或临时故障时自动跳过。
const API_ENDPOINTS = [
  'https://huangguo-parser.13681235735.workers.dev',
  'https://hg-parser-2.13681235735.workers.dev',
  'https://hg-parser-3.13681235735.workers.dev'
];
const PAGE_SIZE = 50; // 一页 50 条

// 每个端点记录近期失败次数与冷却截止时间，避免反复打挂掉的节点
const endpointState = API_ENDPOINTS.map(() => ({ fails: 0, cooldownUntil: 0 }));
let endpointCursor = Math.floor(Math.random() * API_ENDPOINTS.length);

function pickEndpointOrder() {
  const now = Date.now();
  const order = [];
  for (let i = 0; i < API_ENDPOINTS.length; i++) {
    order.push((endpointCursor + i) % API_ENDPOINTS.length);
  }
  // 冷却中的排到最后，但仍作为兜底保留
  order.sort((a, b) => (endpointState[a].cooldownUntil > now ? 1 : 0) - (endpointState[b].cooldownUntil > now ? 1 : 0));
  endpointCursor = (endpointCursor + 1) % API_ENDPOINTS.length;
  return order;
}

function markFail(i) {
  const s = endpointState[i];
  s.fails += 1;
  s.cooldownUntil = Date.now() + Math.min(60000, 3000 * s.fails);
}
function markOk(i) {
  endpointState[i].fails = 0;
  endpointState[i].cooldownUntil = 0;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Worker 返回的封面是相对路径 /media?url=...，需要拼到某个可用端点上。
// 这里用「最近一次成功的端点」拼接，避免图片全部压在同一个 Worker 上。
let lastGoodEndpoint = API_ENDPOINTS[0];
function mediaUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  return lastGoodEndpoint + p;
}

// 依次尝试各端点，任一成功即返回；全部失败才抛错
async function api(path, options) {
  const order = pickEndpointOrder();
  let lastErr = null;
  for (const i of order) {
    const base = API_ENDPOINTS[i];
    try {
      const r = await fetch(base + '/api' + path, options);
      if (!r.ok) { markFail(i); lastErr = Error('HTTP ' + r.status); continue; }
      const data = await r.json();
      markOk(i);
      lastGoodEndpoint = base;
      return data;
    } catch (e) {
      markFail(i);
      lastErr = e;
    }
  }
  throw lastErr || Error('所有接口端点均不可用');
}

function cardHtml(x) {
  const pic = x.vod_pic ? `<img src="${esc(mediaUrl(x.vod_pic))}" loading="lazy" alt="${esc(x.vod_name)}">` : '<span>黄果</span>';
  const score = x.vod_score ? `<i class="score">${esc(String(x.vod_score))}</i>` : '';
  return `<article class="card" data-id="${esc(x.vod_id)}"><div class="cover">${pic}${score}</div><div class="card-body"><h3>${esc(x.vod_name)}</h3><p>${esc(x.vod_remarks || '黄果短剧')}</p></div></article>`;
}
function gridHtml(list) {
  return (list || []).map(cardHtml).join('');
}
// 视频卡片 -> 独立播放页；话题卡片 -> 专辑页
function bindCards(el) {
  el.querySelectorAll('.card').forEach((c) => {
    c.onclick = () => {
      const id = c.dataset.id;
      if (/^topic_/.test(id)) location.href = 'topics.html?slug=' + encodeURIComponent(id.replace('topic_', ''));
      else location.href = 'play.html?id=' + encodeURIComponent(id) + '&ep=1';
    };
  });
}
function fill(el, list, empty) {
  el.innerHTML = list && list.length ? gridHtml(list) : `<div class="empty">${esc(empty || '暂无内容')}</div>`;
  bindCards(el);
}
function chips(el, items, activeKey, onPick) {
  el.innerHTML = (items || []).map((i) => `<button class="${i.v === activeKey ? 'active' : ''}" data-v="${esc(i.v)}">${esc(i.n)}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onPick(b.dataset.v);
    };
  });
}
function setStatus(el, t) {
  if (el) el.textContent = t || '';
}
const CATS_FALLBACK = [
  { type_id: 'ai-duanju', type_name: 'AI成人短剧' },
  { type_id: 'ai-manju', type_name: 'AI成人漫剧' },
  { type_id: 'ai-huanlian', type_name: 'AI换脸' },
  { type_id: 'ai-mogai', type_name: 'AI魔改' }
];
const SORTS_FALLBACK = [
  { n: '最新更新', v: 'latest' },
  { n: '当前热播', v: 'hot' },
  { n: '独家原创', v: 'original' },
  { n: '随机推荐', v: 'random' }
];
const RANK_TABS = [
  { n: '热播榜', v: 'hot' },
  { n: '推荐榜', v: 'recommend' },
  { n: '潜力榜', v: 'potential' }
];
const CHIGUA_TABS = [
  { n: '全部', v: 'all' },
  { n: '热门吃瓜', v: 'remen' },
  { n: 'AI原创', v: 'yuanchuang' }
];
async function loadMeta() {
  try {
    const m = await api('/categories');
    return {
      cats: (m.categories && m.categories.length) ? m.categories.filter((c) => ['ai-duanju', 'ai-manju', 'ai-huanlian', 'ai-mogai'].indexOf(c.type_id) >= 0) : CATS_FALLBACK,
      sorts: (m.sorts && m.sorts.length) ? m.sorts : SORTS_FALLBACK
    };
  } catch (e) {
    return { cats: CATS_FALLBACK, sorts: SORTS_FALLBACK };
  }
}
