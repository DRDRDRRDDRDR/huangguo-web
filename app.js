// 黄果解析站 · 共享脚本
//
// 架构改为浏览器直连源站，Worker 只做封面解密兜底。
//
// 为什么改成直连：源站所有接口和 CDN 都返回 Access-Control-Allow-Origin 星号，
// 浏览器完全可以自己解析。Cloudflare Workers 免费档的 10 万次每天是按账号算的，
// 多开 Worker 不会增加额度，只会把同一份额度分着用。
// 直连后 Worker 只承担封面的 AES 解密，请求量能降一个数量级。
const SITE = 'https://huangguoai.io';
// Worker 只做兜底。留一个就够，额度是账号级的。
const WORKER = 'https://huangguo-parser.13681235735.workers.dev';
const PAGE_SIZE = 50; // 一页 50 条

// 封面解密参数，与 Worker 里一致
const IMG_KEY = 'f5d965df75336270';
const IMG_IV = '97b60394abc2fbe1';

const UA_HEADERS = { 'Accept': 'application/json, text/plain, */*' };

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== 封面：源站是 AES-CBC 加密流，浏览器解密后转 dataURL =====
const coverCache = new Map();

function looksLikeImage(u) {
  if (!u) return false;
  if (/cover-placeholder|logo-huangguo|\.svg|mc\.yandex|google-analytics|pixel|tracker|\/icons\//i.test(u)) return false;
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u);
}

async function decryptCover(url) {
  if (!looksLikeImage(url)) return '';
  if (coverCache.has(url)) return coverCache.get(url);
  try {
    const r = await fetch(url);
    if (!r.ok) return '';
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length % 16) return '';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(IMG_KEY), 'AES-CBC', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(IMG_IV) }, key, buf));
    const pad = plain[plain.length - 1];
    const body = (pad > 0 && pad <= 16 && plain.slice(-pad).every((x) => x === pad)) ? plain.slice(0, -pad) : plain;
    let type = 'image/jpeg';
    if (body[0] === 0x89 && body[1] === 0x50) type = 'image/png';
    else if (body[0] === 0x52 && body[1] === 0x49) type = 'image/webp';
    else if (body[0] === 0x47 && body[1] === 0x49) type = 'image/gif';
    let bin = '';
    for (let i = 0; i < body.length; i += 8192) bin += String.fromCharCode.apply(null, body.subarray(i, i + 8192));
    const dataUrl = 'data:' + type + ';base64,' + btoa(bin);
    coverCache.set(url, dataUrl);
    return dataUrl;
  } catch (e) { return ''; }
}

// ===== 反爬签名 =====
// Worker 用同一密钥与算法校验，窗口 5 分钟。密钥在前端可见，
// 目的是挡掉不执行 JS 的脚本爬虫，不是对抗有心的逆向者。
const HG_SIG_SECRET = 'hg-dx150-2026-11-w7Qm4pLz';

async function hmacHex(msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(HG_SIG_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 对 path+query 生成签名，必须与实际请求的 URL 完全一致
async function signHeaders(pathWithQuery) {
  const win = Math.floor(Date.now() / 1000 / 300);
  const sig = await hmacHex(win + '\n' + pathWithQuery);
  return { 'X-HG-Ts': String(win * 300), 'X-HG-Sig': sig };
}

function mediaUrl(p) {
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  if (p.charAt(0) === '/') return SITE + p;
  return p;
}

// ===== 路径翻译 =====
// 页面沿用旧 Worker 的接口风格，这里翻译成源站的真实路径。
// 好处是所有 html 一行都不用改，风险面最小。
function translatePath(path) {
  let p = path.split('?')[0];
  const qs = path.indexOf('?') >= 0 ? path.slice(path.indexOf('?')) : '';
  let m;
  // /category/{tid}  ->  /videos/category/{tid}
  if ((m = p.match(/^\/category\/([^\/]+)$/))) return '/videos/category/' + m[1] + qs;
  // /search/{kw}  ->  /search?q={kw}&...
  if ((m = p.match(/^\/search\/(.+)$/))) {
    const sep = qs ? '&' : '?';
    return '/search?q=' + m[1] + (qs ? sep + qs.slice(1) : '');
  }
  // /detail/{id}  ->  /videos/{id}
  if ((m = p.match(/^\/detail\/([^\/]+)$/))) return '/videos/' + m[1];
  // /chigua?...  ->  /posts?...  站点把吃瓜放在 posts 下
  if (p === '/chigua') return '/posts' + qs;
  // 其余路径源站同构，原样透传
  return p + qs;
}

// Worker 的返回格式与源站不同，这里把源站原始响应包成页面期望的形状。
// 页面读的是 {list:[...], total, page}，源站给的是 {data:{items, pagination}}。
function shapeResponse(path, raw) {
  const p = path.split('?')[0];
  if (p === '/' || p === '/categories') return raw;
  const d = raw && raw.data;
  if (!d) return raw;
  // 详情：包成 list
  if (/^\/detail\//.test(p)) return { list: [fromItem(d)], total: 1 };
  // 分类 / 搜索 / 榜单：items -> list
  if (d.items) {
    const pg = d.pagination || {};
    return { list: d.items.map(fromItem), total: pg.total || 0, page: pg.page || 1 };
  }
  if (d.id) return { list: [fromItem(d)], total: 1 };
  return raw;
}

// ===== 请求封装：直连源站优先，Worker 兜底 =====
async function api(path, options) {
  const target = translatePath(path);
  const url = SITE + '/api' + target;
  try {
    const r = await fetch(url, Object.assign({ headers: Object.assign({}, UA_HEADERS) }, options || {}));
    if (!r.ok) throw Error('HTTP ' + r.status);
    return shapeResponse(path, await r.json());
  } catch (e) {
    // 直连失败才回落 Worker，路径用原始的 Worker 风格
    const r2 = await fetch(WORKER + '/api' + path, Object.assign({ headers: Object.assign({}, UA_HEADERS) }, options || {}));
    if (!r2.ok) throw e;
    return await r2.json();
  }
}

// ===== 数据归一化 =====
function cleanTitle(s) {
  let t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  t = t.replace(/全集在线观看/g, '');
  t = t.replace(/[-–—|]\s*黄果短剧(吃瓜社区|社区)?\s*$/, '');
  t = t.replace(/黄果吃瓜侠\s*[·•]\s*\d{4}-\d{2}-\d{2}\s*[·•]\s*\S*/g, '');
  t = t.replace(/吃瓜社区/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

function remarksOf(it) {
  const parts = [];
  if (it.is_finished) {
    const n = Number(it.total_episodes || it.episode_count || 0);
    parts.push(n ? '全' + n + '集' : '已完结');
  } else if (it.episode_count) parts.push('更新至' + it.episode_count + '集');
  if (it.score) parts.push(it.score + '分');
  return parts.join(' · ');
}

function fromItem(it) {
  return {
    vod_id: String(it.id),
    vod_name: cleanTitle(it.title),
    vod_pic: mediaUrl(it.cover || ''),
    vod_remarks: remarksOf(it),
    vod_score: it.score || '',
    vod_desc: it.description || '',
    episode_count: Number(it.episode_count || 0),
    total_episodes: Number(it.total_episodes || 0),
    is_finished: !!it.is_finished
  };
}

function cardHtml(x) {
  const ph = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320"><rect width="240" height="320" fill="#1a1a1a"/><text x="120" y="165" fill="#555" font-size="16" text-anchor="middle">黄果</text></svg>');
  const score = x.vod_score ? `<i class="score">${esc(String(x.vod_score))}</i>` : '';
  return `<article class="card" data-id="${esc(x.vod_id)}" data-cover="${esc(x.vod_pic)}">`
    + `<div class="cover"><img src="${ph}" loading="lazy" alt="${esc(x.vod_name)}">${score}</div>`
    + `<div class="card-body"><h3>${esc(x.vod_name)}</h3><p>${esc(x.vod_remarks || '黄果短剧')}</p></div></article>`;
}

function gridHtml(list) {
  return (list || []).map(cardHtml).join('');
}

async function hydrateCovers(root) {
  const cards = Array.from(root.querySelectorAll('.card[data-cover]:not([data-cover-done])'));
  let idx = 0;
  async function runner() {
    while (idx < cards.length) {
      const card = cards[idx++];
      card.setAttribute('data-cover-done', '1');
      const url = card.dataset.cover;
      if (!url) continue;
      const img = card.querySelector('.cover img');
      if (!img) continue;
      const dataUrl = await decryptCover(url);
      if (dataUrl) img.src = dataUrl;
    }
  }
  await Promise.all(Array.from({ length: 4 }, runner));
}

// 各页面直接用 insertAdjacentHTML 插卡片，不经过 fill，
// 所以用 MutationObserver 监听整篇文档，新卡片一出现就解封面。
function bootCoverObserver() {
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  const scan = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.classList && node.classList.contains('card')) hydrateCovers(node.parentNode || node);
    else if (node.querySelectorAll) hydrateCovers(node);
  };
  const mo = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) scan(node);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  // 首屏已有的卡片也补一次
  hydrateCovers(document.body);
}

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
  hydrateCovers(el);
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

function setStatus(el, t) { if (el) el.textContent = t || ''; }

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
  return { cats: CATS_FALLBACK, sorts: SORTS_FALLBACK };
}

// ===== 页面级接口：直连源站并归一化 =====
async function getCategory(tid, sort, page, size) {
  const q = '/videos/category/' + encodeURIComponent(tid) + '?page=' + page + '&size=' + size + '&sort=' + encodeURIComponent(sort || 'latest');
  const d = await api(q);
  const items = (d && d.data && d.data.items) || [];
  const pg = (d && d.data && d.data.pagination) || {};
  return { list: items.map(fromItem), page: pg.page || page, total: pg.total || 0, hasMore: items.length >= size };
}

async function getDetail(id) {
  const d = await api('/videos/' + encodeURIComponent(id));
  const it = (d && d.data) || {};
  const eps = [];
  const n = Number(it.episode_count || it.total_episodes || 1);
  for (let i = 1; i <= n; i++) eps.push({ ep: String(i), url: SITE + '/video/' + id + '/' });
  return { item: fromItem(it), episodes: eps, raw: it };
}

async function getTopics() {
  const d = await api('/topics');
  const items = (d && d.data && d.data.items) || [];
  return items.map((t, i) => ({
    vod_id: 'topic_' + (t.slug || i),
    vod_name: cleanTitle(t.title),
    vod_pic: mediaUrl(t.cover || ''),
    vod_remarks: (t.video_count || t.count || 0) + ' 部'
  }));
}

async function getChigua(cate, page, size) {
  const d = await api('/chigua?cate=' + encodeURIComponent(cate || 'all') + '&page=' + page + '&size=' + size);
  const items = (d && d.data && d.data.items) || [];
  return {
    list: items.map((p) => ({
      vod_id: String(p.id),
      vod_name: cleanTitle(p.title || p.content || ''),
      vod_pic: mediaUrl(p.cover || ''),
      vod_remarks: p.created_at || ''
    })),
    total: (d && d.data && d.data.pagination && d.data.pagination.total) || 0
  };
}

async function getSearch(kw, page, size) {
  const d = await api('/search?q=' + encodeURIComponent(kw) + '&page=' + page + '&size=' + size);
  const items = (d && d.data && d.data.items) || [];
  return {
    list: items.map(fromItem),
    total: (d && d.data && d.data.pagination && d.data.pagination.total) || 0
  };
}

// ===== 浏览器端取播放地址：直连源站的加密通道 =====
// 站点把业务接口放在 dx150-edge-v1 通道里，握手是 ECDH P-256，
// 派生用 HKDF-SHA256，载荷是 AES-GCM。全部用 WebCrypto 实现。
const DX_PROTOCOL = 'dx150-edge-v1';
const DX_ENDPOINTS = {
  user: '/api/user/request',
  playback: '/api/playback/request',
  public: '/api/public/request',
  dynamic: '/api/dynamic/request'
};

function dxB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function dxUb64u(v) {
  const s = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
function dxUb64(v) {
  const s = atob(v);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
function dxB64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  return btoa(s);
}
function dxNonce(seq) {
  const b = new Uint8Array(12);
  new DataView(b.buffer).setUint32(8, seq, false);
  return b;
}

const dxSessions = {};

async function dxOpen(scope) {
  const enc = new TextEncoder();
  const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
  const pair = await crypto.subtle.generateKey(ecdh, false, ['deriveBits']);
  const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
  const hr = await fetch(SITE + DX_ENDPOINTS[scope], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'hello', client_pub: dxB64u(new Uint8Array(pub)) })
  });
  if (!hr.ok) throw Error('dx hello ' + hr.status);
  const hello = await hr.json();
  if (!hello || hello.v !== 1 || hello.type !== 'hello') throw Error('dx bad hello');
  const sp = await crypto.subtle.importKey('raw', dxUb64u(hello.server_pub), ecdh, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: sp }, pair.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = dxUb64u(hello.salt);
  const info = [DX_PROTOCOL, scope, hello.site, hello.kid, hello.sid].join('\n');
  const mk = (dir, op) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info + '\n' + dir) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, [op]
  );
  const keys = await Promise.all([mk('req', 'encrypt'), mk('res', 'decrypt')]);
  const lt = Math.floor(Date.now() / 1000);
  const s = {
    info, kid: hello.kid, sid: hello.sid,
    off: hello.server_time - lt,
    exp: lt + hello.expires_at - hello.server_time,
    seq: 0, rk: keys[0], sk: keys[1]
  };
  dxSessions[scope] = s;
  return s;
}

async function dxCall(scope, packet) {
  const enc = new TextEncoder();
  let s = dxSessions[scope];
  if (!s || s.exp <= Math.floor(Date.now() / 1000) + 5) s = await dxOpen(scope);
  const seq = ++s.seq;
  const ts = Math.floor(Date.now() / 1000) + s.off;
  const iv = dxNonce(seq);
  const params = (dir) => ({
    name: 'AES-GCM', iv,
    additionalData: enc.encode([s.info, dir, seq, ts].join('\n'))
  });
  const cipher = await crypto.subtle.encrypt(params('req'), s.rk, enc.encode(JSON.stringify({ request: packet })));
  const r = await fetch(SITE + DX_ENDPOINTS[scope], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 1, type: 'call', kid: s.kid, sid: s.sid, seq, ts, ciphertext: dxB64u(new Uint8Array(cipher)) })
  });
  if (!r.ok) { delete dxSessions[scope]; throw Error('dx call ' + r.status); }
  const j = await r.json();
  const plain = await crypto.subtle.decrypt(params('res'), s.sk, dxUb64u(j.ciphertext));
  const inner = JSON.parse(new TextDecoder().decode(plain));
  return { status: inner.status, body: new TextDecoder().decode(dxUb64(inner.body)) };
}

function dxPacket(method, path, obj) {
  const bytes = new TextEncoder().encode(obj === undefined ? '' : JSON.stringify(obj));
  return { method, path, body: dxB64(bytes), content_type: obj === undefined ? '' : 'application/json', visitor_id: '' };
}

// 取播放地址。
// 实测：源站加密端点对 Origin 为 github.io 的请求返回 403，
// 而浏览器跨域 POST 必然带 Origin，所以播放这一步必须走 Worker。
// 好在只此一步，列表、封面、m3u8、分片全部由浏览器直连。
async function getPlay(id, ep) {
  const path = '/play?url=' + encodeURIComponent(SITE + '/video/' + id + '/') + '&ep=' + ep;
  const sig = await signHeaders('/api' + path);
  const r = await fetch(WORKER + '/api' + path, { headers: Object.assign({ 'Accept': 'application/json, text/plain, */*' }, sig) });
  if (!r.ok) throw Error('play HTTP ' + r.status);
  const d = await r.json();
  if (!d || !d.url) throw Error('无播放地址');
  return { url: d.url, proxy: d.proxy || '', hevc: d.hevc || '', source: d.source || 'worker', declaredDuration: d.declaredDuration || 0 };
}

// 页面就绪即开始监听新卡片并解封面
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootCoverObserver);
  else bootCoverObserver();
}
