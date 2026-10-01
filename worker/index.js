// 黄果短剧解析 Worker（Cloudflare Workers 免费档）
// 数据来源：https://huangguoai.com
// 适配参考：jinshengchan/huangguo-fongmi、cluntop/tvbox(huangguo.py / huangguo2.py)
//
// 设计要点：
// 1. 优先使用黄果官方 JSON 接口（/api/videos/category、/api/ranks、/api/videos/{id}、/api/topics），
//    HTML 抓取仅作兜底 —— 官方接口含分页元数据、评分、标签，比正则解析可靠。
// 2. 封面为 AES-CBC 加密的**原始二进制**（非 base64 文本），须按二进制解密后校验图片魔数。
// 3. m3u8 为 AES-128 加密切片，通过 /raw 代理重写分片与密钥 URI，保证继续走本 Worker。
// 4. 浏览器 <video> 原生不支持 HLS，播放器库由 /hls.js 代理提供（避免公共 CDN 不可达）。

const SITE = 'https://huangguoai.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

const IMG_KEY = 'f5d965df75336270';
const IMG_IV = '97b60394abc2fbe1';
const EMPTY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CATEGORIES = [
  { type_id: 'recommend', type_name: '精选推荐' },
  { type_id: 'ai-duanju', type_name: 'AI成人短剧' },
  { type_id: 'ai-manju', type_name: 'AI成人漫剧' },
  { type_id: 'ai-huanlian', type_name: 'AI换脸' },
  { type_id: 'ai-mogai', type_name: 'AI魔改' },
  { type_id: 'ranks', type_name: '排行榜' },
  { type_id: 'chigua', type_name: '黄果吃瓜' },
  { type_id: 'topics', type_name: '话题精选' }
];
const SORTS = [
  { n: '最新更新', v: 'latest' },
  { n: '当前热播', v: 'hot' },
  { n: '独家原创', v: 'original' },
  { n: '随机推荐', v: 'random' }
];
const RANKS = ['hot', 'recommend', 'potential'];
const CHIGUA = ['all', 'remen', 'yuanchuang'];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...CORS, 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' }
  });
}
function abs(u) {
  if (!u) return '';
  if (u.indexOf('//') === 0) return 'https:' + u;
  if (u.charAt(0) === '/') return SITE + u;
  return u;
}
function clean(x) {
  return String(x || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
function isRealImage(u) {
  if (!u) return false;
  if (/cover-placeholder|logo-huangguo|\.svg|mc\.yandex|google-analytics|pixel|tracker|\/icons\//i.test(u)) return false;
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u);
}
function magic(b) {
  if (!b || b.length < 3) return '';
  if (b[0] === 255 && b[1] === 216) return 'image/jpeg';
  if (b[0] === 137 && b[1] === 80 && b[2] === 78) return 'image/png';
  if (b[0] === 82 && b[1] === 73) return 'image/webp';
  if (b[0] === 71 && b[1] === 73) return 'image/gif';
  return '';
}

async function request(u, type) {
  try {
    const r = await fetch(u, {
      headers: {
        'User-Agent': UA,
        'Referer': SITE + '/',
        'Accept': type === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });
    if (!r.ok) return type === 'json' ? null : '';
    if (type === 'json') {
      try { return await r.json(); } catch (e) { return null; }
    }
    return await r.text();
  } catch (e) {
    return type === 'json' ? null : '';
  }
}
const getHtml = (u) => request(u, 'html');
const getJson = (u) => request(u, 'json');

async function aesDecrypt(bytes) {
  if (!bytes || !bytes.length || bytes.length % 16) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(IMG_KEY), 'AES-CBC', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: new TextEncoder().encode(IMG_IV) }, key, bytes
    ));
    const pad = plain[plain.length - 1];
    if (pad > 0 && pad <= 16 && plain.slice(-pad).every((x) => x === pad)) return plain.slice(0, -pad);
    return plain;
  } catch (e) {
    return null;
  }
}

function imageProxy(u) {
  return isRealImage(u) ? '/media?url=' + encodeURIComponent(abs(u)) : '';
}
function buildRemarks(it) {
  if (!it) return '';
  const parts = [];
  if (it.is_finished) {
    const n = Number(it.total_episodes || it.episode_count || 0);
    parts.push(n ? '全' + n + '集' : '已完结');
  } else if (it.episode_count) {
    parts.push('更新至' + it.episode_count + '集');
  }
  if (it.score) parts.push(it.score + '分');
  if (Array.isArray(it.tags) && it.tags.length) parts.push(it.tags.slice(0, 3).join('·'));
  return parts.join(' · ');
}
function fromApiItem(it) {
  return {
    vod_id: String(it.id || it.video_id || ''),
    vod_name: it.title || '',
    vod_pic: imageProxy(it.cover || ''),
    vod_remarks: buildRemarks(it),
    vod_score: it.score || 0,
    vod_hot: it.hot || 0,
    vod_tags: it.tags || [],
    vod_desc: it.description || '',
    vod_episode_count: it.episode_count || 0,
    vod_finished: !!it.is_finished,
    vod_original: !!it.is_original,
    vod_created: it.created_at || ''
  };
}
function fromRankItem(it) {
  const o = fromApiItem(it);
  o.vod_id = String(it.video_id || it.id || '');
  if (it.rank) o.vod_remarks = ('#' + it.rank + ' ' + (it.metric_label || '') + (it.metric_value || '') + ' · ' + o.vod_remarks).replace(/ · $/, '');
  return o;
}

// HTML 兜底解析：以 hg-drama-card 容器为边界，避免跨卡片串图
function parseCards(html) {
  const starts = [];
  const re = /<div\s+class="[^"]*\bhg-drama-card\b[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index + m[0].length);
  if (!starts.length) return [];
  const out = [];
  const seen = {};
  for (let i = 0; i < starts.length; i++) {
    const slice = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, starts[i] + 6000));
    const lm = slice.match(/href="([^"]*\/video\/(\d+)\/)"[^>]*>[\s\S]*?<\/a>/i) || slice.match(/href="([^"]*\/detail\/(\d+)\/)"/i);
    if (!lm) continue;
    const id = lm[2];
    if (seen[id]) continue;
    const tm = slice.match(/class="[^"]*hg-drama-card__title[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    let name = tm ? clean(tm[1]) : '';
    if (!name) {
      const am = slice.match(/<img[^>]+alt="([^"]+)"/i);
      if (am) name = clean(am[1]);
    }
    name = name.replace(/全集在线观看/g, '').trim();
    if (!name || /^\d+$/.test(name)) continue;
    const pics = [];
    const ri = /(?:data-src|data-original|src)="([^"]+)"/gi;
    let x;
    while ((x = ri.exec(slice))) if (isRealImage(x[1])) pics.push(x[1]);
    const em = slice.match(/hg-drama-card__episode[^>]*>([\s\S]*?)<\/span>/i);
    const sm = slice.match(/hg-drama-card__score[^>]*>([\s\S]*?)<\/span>/i);
    seen[id] = 1;
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: imageProxy(pics[0] || ''),
      vod_remarks: [em && clean(em[1]), sm && clean(sm[1])].filter(Boolean).join(' · '),
      vod_tags: [],
      vod_desc: ''
    });
  }
  return out;
}
function parseRankCards(html) {
  const out = [];
  const seen = {};
  const re = /href="([^"]*\/detail\/(\d+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[2];
    if (seen[id]) continue;
    const name = clean(m[3]);
    if (!name || name.length > 60) continue;
    const around = html.slice(Math.max(0, m.index - 2000), Math.min(html.length, m.index + 2000));
    const pics = [];
    const ri = /(?:data-src|data-original|src)="([^"]+)"/gi;
    let x;
    while ((x = ri.exec(around))) if (isRealImage(x[1])) pics.push(x[1]);
    seen[id] = 1;
    out.push({ vod_id: id, vod_name: name, vod_pic: imageProxy(pics[0] || ''), vod_remarks: '排行榜', vod_tags: [], vod_desc: '' });
  }
  return out;
}
function parseEpisodes(id, html) {
  const list = [{ ep: '1', url: SITE + '/video/' + id + '/', title: '第1集' }];
  const seen = { '1': 1 };
  const re = new RegExp('href="([^"]*\\/video\\/' + id + '\\/ep-(\\d+)\\/)"', 'gi');
  let m;
  while ((m = re.exec(html))) {
    if (!seen[m[2]]) {
      seen[m[2]] = 1;
      list.push({ ep: m[2], url: abs(m[1]), title: '第' + m[2] + '集' });
    }
  }
  return list.sort((a, b) => Number(a.ep) - Number(b.ep));
}
function coverOf(html) {
  const m = html.match(/id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      if (isRealImage(data.coverSrc)) return data.coverSrc;
    } catch (e) {}
  }
  const og = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return og && isRealImage(og[1]) ? og[1] : '';
}

async function category(tid, sort, page, size) {
  const api = await getJson(SITE + '/api/videos/category/' + encodeURIComponent(tid) + '?page=' + page + '&size=' + size + '&sort=' + encodeURIComponent(sort));
  if (api && api.data && Array.isArray(api.data.items) && api.data.items.length) {
    const p = api.data.pagination || {};
    return { list: api.data.items.map(fromApiItem), page: p.page || page, pagecount: p.pages || 1, total: p.total || api.data.items.length, limit: p.size || size, source: 'api' };
  }
  const html = await getHtml(SITE + '/' + tid + ('/' + (page > 1 ? page + '/' : '')));
  const cards = parseCards(html);
  const pm = html.match(/data-panel-total="(\d+)"/);
  const total = pm ? Number(pm[1]) : 0;
  return { list: cards, page, pagecount: total ? Math.max(1, Math.ceil(total / size)) : 1, total: total || cards.length, limit: size, source: 'html' };
}
async function ranks(type, page, size) {
  const api = await getJson(SITE + '/api/ranks/' + encodeURIComponent(type) + '?page=' + page + '&size=' + size);
  if (api && api.data && Array.isArray(api.data.items) && api.data.items.length) {
    const p = api.data.pagination || {};
    return { list: api.data.items.map(fromRankItem), page: p.page || page, pagecount: p.pages || 1, total: p.total || api.data.items.length, limit: p.size || size, source: 'api' };
  }
  const html = await getHtml(SITE + '/ranks/' + (type || 'hot') + ('/' + (page > 1 ? page + '/' : '')));
  return { list: parseRankCards(html), page, pagecount: 1, total: 0, limit: size, source: 'html' };
}
async function topics(slug, page, size) {
  if (!slug) {
    const api = await getJson(SITE + '/api/topics');
    const items = (api && api.data && api.data.items) || [];
    return {
      list: items.map((t) => ({
        vod_id: 'topic_' + t.slug,
        vod_name: t.title,
        vod_pic: imageProxy(t.cover || ''),
        vod_remarks: t.video_count + '部 · ' + t.slug,
        vod_tags: [],
        vod_desc: t.intro || ''
      })),
      page: 1, pagecount: 1, total: items.length, limit: size, source: 'api'
    };
  }
  const html = await getHtml(SITE + '/topics/' + encodeURIComponent(slug) + '/' + (page > 1 ? '?page=' + page : ''));
  const cards = parseCards(html);
  const pm = html.match(/data-pages="(\d+)"/);
  return { list: cards.slice(0, size), page, pagecount: pm ? Number(pm[1]) : 1, total: cards.length, limit: size, source: 'html' };
}
async function chigua(cate, page, size) {
  const base = cate && cate !== 'all' ? '/chigua/' + encodeURIComponent(cate) : '/chigua';
  const html = await getHtml(SITE + base + '/' + (page > 1 ? 'page/' + page + '/' : ''));
  const out = [];
  const seen = {};
  const re = /<a[^>]+href="(\/archives\/(\d+)\/)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const pid = m[2];
    if (seen[pid]) continue;
    const around = html.slice(Math.max(0, m.index - 1500), Math.min(html.length, m.index + 1500));
    const tm = around.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const name = clean(tm ? tm[1] : m[3]);
    if (!name || name.length > 80) continue;
    const pics = [];
    const ri = /(?:data-src|src)="(https?:\/\/[^"]+)"/gi;
    let x;
    while ((x = ri.exec(around))) if (isRealImage(x[1])) pics.push(x[1]);
    seen[pid] = 1;
    out.push({ vod_id: 'archives_' + pid, vod_name: name, vod_pic: imageProxy(pics[0] || ''), vod_remarks: '吃瓜', vod_tags: [], vod_desc: '' });
  }
  const pm = html.match(/data-pages="(\d+)"/);
  return { list: out.slice(0, size), page, pagecount: pm ? Number(pm[1]) : 1, total: out.length, limit: size, source: 'html' };
}
async function detail(id) {
  if (/^archives_/.test(id)) {
    const pid = id.replace('archives_', '');
    const html = await getHtml(SITE + '/archives/' + pid + '/');
    const tm = html.match(/<title>([\s\S]*?)<\/title>/i);
    let v = '';
    const vm = html.match(/<video[^>]+src="(https?:\/\/[^"]+)"/i) || html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i) || html.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i);
    if (vm) v = vm[1];
    return {
      list: [{
        vod_id: id,
        vod_name: clean(tm ? tm[1] : '吃瓜' + pid).replace(/ - 黄果短剧/, ''),
        vod_pic: imageProxy(coverOf(html)),
        vod_remarks: '吃瓜',
        vod_desc: '',
        episodes: v ? [{ ep: '1', url: v, title: '第1集' }] : []
      }]
    };
  }
  const api = await getJson(SITE + '/api/videos/' + encodeURIComponent(id));
  const html = await getHtml(SITE + '/video/' + id + '/');
  const fallbackEps = parseEpisodes(id, html);
  if (api && api.data && api.data.id) {
    const d = api.data;
    const eps = (d.episodes || []).map((e) => {
      const n = String(e.ep_num);
      return {
        ep: n,
        url: n === '1' ? SITE + '/video/' + id + '/' : SITE + '/video/' + id + '/ep-' + n + '/',
        title: e.title || '第' + n + '集',
        duration: e.duration || 0
      };
    });
    return {
      list: [{
        vod_id: String(d.id),
        vod_name: d.title || id,
        vod_pic: imageProxy(d.cover || ''),
        vod_remarks: buildRemarks(d),
        vod_desc: d.description || '',
        vod_score: d.score || 0,
        vod_tags: d.tags || [],
        vod_year: (d.created_at || '').slice(0, 4),
        vod_episode_count: d.episode_count || eps.length,
        vod_finished: !!d.is_finished,
        vod_original: !!d.is_original,
        vod_created: d.created_at || '',
        episodes: eps.length ? eps : fallbackEps,
        source: 'api'
      }]
    };
  }
  return {
    list: [{
      vod_id: id,
      vod_name: clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || id,
      vod_pic: imageProxy(coverOf(html)),
      vod_remarks: '',
      vod_desc: '',
      episodes: fallbackEps,
      source: 'html'
    }]
  };
}
async function search(keyword, page, size) {
  const api = await getJson(SITE + '/api/search?keyword=' + encodeURIComponent(keyword) + '&page=' + page + '&size=' + size);
  if (api && api.data && Array.isArray(api.data.items) && api.data.items.length) {
    const p = api.data.pagination || {};
    return { list: api.data.items.map(fromApiItem), page: p.page || page, pagecount: p.pages || 1, total: p.total || api.data.items.length, limit: p.size || size, source: 'api' };
  }
  const html = await getHtml(SITE + '/search/video/' + encodeURIComponent(keyword) + '/');
  const cards = parseCards(html);
  return { list: cards, page, pagecount: 1, total: cards.length, limit: size, source: 'html' };
}

// 封面：原始二进制密文 -> AES-CBC 解密 -> 校验魔数
async function media(url) {
  const fallback = () => new Response(EMPTY_PNG, { headers: { ...CORS, 'content-type': 'image/png' } });
  if (!/^https?:\/\//i.test(url || '')) return fallback();
  let r = null;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } });
  } catch (e) {
    return fallback();
  }
  if (!r || !r.ok) return fallback();
  const bytes = new Uint8Array(await r.arrayBuffer());
  const direct = magic(bytes);
  if (direct) return new Response(bytes, { headers: { ...CORS, 'content-type': direct, 'cache-control': 'public,max-age=86400' } });
  const plain = await aesDecrypt(bytes);
  const type = plain ? magic(plain) : '';
  if (plain && type) return new Response(plain, { headers: { ...CORS, 'content-type': type, 'cache-control': 'public,max-age=86400' } });
  return fallback();
}

// HLS 代理：重写 m3u8 内分片与密钥地址
async function proxyRaw(url, origin) {
  if (!/^https?:\/\//i.test(url || '')) return new Response(null, { status: 400, headers: CORS });
  let r = null;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } });
  } catch (e) {
    return new Response(null, { status: 502, headers: CORS });
  }
  const contentType = r.headers.get('content-type') || '';
  const buf = new Uint8Array(await r.arrayBuffer());
  if (new TextDecoder().decode(buf.slice(0, 7)) === '#EXTM3U') {
    let base = null;
    try { base = new URL(url); } catch (e) { base = null; }
    const rewrite = (href) => {
      let target = href;
      try { target = new URL(href, base).href; } catch (e) {}
      return origin + '/raw?url=' + encodeURIComponent(target);
    };
    const text = new TextDecoder().decode(buf).split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.charAt(0) === '#') return line.replace(/URI="([^"]+)"/gi, (w, p1) => 'URI="' + rewrite(p1) + '"');
      return rewrite(t);
    }).join('\n');
    return new Response(text, { headers: { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } });
  }
  return new Response(buf, { headers: { ...CORS, 'content-type': contentType || 'application/octet-stream', 'cache-control': 'public,max-age=3600' } });
}

async function hlsLib() {
  const cdns = [
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
    'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js'
  ];
  for (let i = 0; i < cdns.length; i++) {
    try {
      const r = await fetch(cdns[i]);
      if (r.ok) {
        const b = await r.arrayBuffer();
        return new Response(b, { headers: { ...CORS, 'content-type': 'application/javascript;charset=utf-8', 'cache-control': 'public,max-age=604800' } });
      }
    } catch (e) {}
  }
  return new Response('/* hls.js unavailable */', { status: 502, headers: { ...CORS, 'content-type': 'application/javascript' } });
}

async function play(page, ep) {
  const html = await getHtml(page);
  const m = html.match(/id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i);
  let stream = '';
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      stream = (data.epPlaySrcs && data.epPlaySrcs[ep]) || data.videoSrc || '';
    } catch (e) {}
  }
  if (!stream) {
    const id = (page.match(/\/video\/(\d+)/) || [])[1];
    if (id) {
      const api = await getJson(SITE + '/api/videos/' + id);
      if (api && api.data) stream = api.data.video_url || '';
    }
  }
  if (!stream) {
    const mm = html.match(/https?:\/\/[^"'<>\s]+?\.(?:m3u8|mp4)(?:\?[^"'<>\s]*)?/i);
    if (mm) stream = mm[0];
  }
  return stream.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

async function handle(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  const origin = url.origin;
  try {
    if (url.pathname === '/hls.js') return hlsLib();
    if (url.pathname === '/media') return media(url.searchParams.get('url'));
    if (url.pathname === '/raw') return proxyRaw(url.searchParams.get('url'), origin);
    if (url.pathname.indexOf('/api') !== 0) {
      return new Response('Huangguo Parser API', { headers: { ...CORS, 'content-type': 'text/plain;charset=utf-8' } });
    }

    const path = url.pathname.slice(4);
    const page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
    const size = Math.min(60, Math.max(1, Number(url.searchParams.get('size') || 24) || 24));
    const sort = url.searchParams.get('sort') || 'latest';

    if (path === '/') return json({ status: 'ok', categories: CATEGORIES, sorts: SORTS });
    if (path === '/categories') return json({ categories: CATEGORIES, sorts: SORTS, ranks: RANKS, chigua: CHIGUA });
    if (path === '/all') {
      const out = { categories: CATEGORIES, sorts: SORTS, ranks: RANKS, chigua: CHIGUA, sections: {} };
      const section = async (key, fn) => {
        try { out.sections[key] = await fn(); } catch (e) { out.sections[key] = { error: String(e) }; }
      };
      await section('recommend', () => category('ai-duanju', 'latest', 1, 12));
      await section('ranksHot', () => ranks('hot', 1, 10));
      await section('topics', () => topics('', 1, 9));
      await section('chigua', () => chigua('all', 1, 8));
      return json(out);
    }
    if (path.indexOf('/category/') === 0) return json(await category(path.split('/')[2] || 'ai-duanju', sort, page, size));
    if (path.indexOf('/ranks/') === 0) return json(await ranks(path.split('/')[2] || 'hot', page, size));
    if (path.indexOf('/topics') === 0) return json(await topics(url.searchParams.get('slug') || '', page, size));
    if (path.indexOf('/chigua') === 0) return json(await chigua(url.searchParams.get('cate') || 'all', page, size));
    if (path.indexOf('/search/') === 0) return json(await search(decodeURIComponent(path.split('/')[2] || ''), page, size));
    if (path.indexOf('/detail/') === 0) return json(await detail(path.split('/')[2] || ''));
    if (path === '/play') {
      const stream = await play(decodeURIComponent(url.searchParams.get('url') || ''), url.searchParams.get('ep') || '1');
      return json({ url: stream, proxy: stream ? origin + '/raw?url=' + encodeURIComponent(stream) : '' });
    }
    if (path === '/recommend') return json(await category('ai-duanju', 'latest', 1, 20));
    return json(await category(path.replace(/^\//, '').replace(/\/$/, '') || 'ai-duanju', sort, page, size));
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
