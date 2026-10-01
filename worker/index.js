// 黄果短剧解析 Worker（Cloudflare Workers 免费档）
// 数据来源：https://huangguoai.com
// 适配逻辑参考：https://github.com/jinshengchan/huangguo-fongmi

const SITE = 'https://huangguoai.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

// 封面为 AES-CBC 加密的原始二进制（非 base64 文本），密钥与 IV 与上游 FongMi 脚本一致
const IMG_KEY = 'f5d965df75336270';
const IMG_IV = '97b60394abc2fbe1';

const EMPTY_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
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
    .trim();
}

// 源站封面位是懒加载的 data-src；同时必须排除占位图与统计像素
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

async function getText(u) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': SITE + '/' } });
    return r.ok ? await r.text() : '';
  } catch (e) {
    return '';
  }
}

async function aesDecrypt(bytes) {
  if (!bytes || !bytes.length || bytes.length % 16) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(IMG_KEY), 'AES-CBC', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: new TextEncoder().encode(IMG_IV) }, key, bytes
    ));
    const pad = plain[plain.length - 1];
    if (pad > 0 && pad <= 16 && plain.slice(-pad).every(x => x === pad)) return plain.slice(0, -pad);
    return plain;
  } catch (e) {
    return null;
  }
}

function imageProxy(u) {
  return isRealImage(u) ? '/media?url=' + encodeURIComponent(abs(u)) : '';
}

// 以 hg-drama-card 容器为边界切片，避免跨卡片串图
function parseCards(html) {
  const starts = [];
  const re = /<div\s+class="[^"]*\bhg-drama-card\b[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index + m[0].length);

  const out = [];
  const seen = {};
  for (let i = 0; i < starts.length; i++) {
    const slice = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, starts[i] + 6000));
    const link = slice.match(/href="([^"]*\/video\/(\d+)\/)"/i);
    if (!link) continue;
    const id = link[2];
    if (seen[id]) continue;

    const titleMatch = slice.match(/class="[^"]*hg-drama-card__title[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    let name = titleMatch ? clean(titleMatch[1]) : '';
    if (!name) {
      const alt = slice.match(/<img[^>]+alt="([^"]+)"/i);
      if (alt) name = clean(alt[1]);
    }
    name = name.replace(/全集在线观看/g, '').trim();
    if (!name || /^\d+$/.test(name)) continue;

    const pics = [];
    const imgRe = /(?:data-src|data-original|src)="([^"]+)"/gi;
    let x;
    while ((x = imgRe.exec(slice))) if (isRealImage(x[1])) pics.push(x[1]);

    seen[id] = 1;
    out.push({ vod_id: id, vod_name: name, vod_pic: imageProxy(pics[0] || ''), vod_remarks: '' });
  }
  return out;
}

function parseEpisodes(id, html) {
  const list = [{ ep: '1', url: SITE + '/video/' + id + '/' }];
  const seen = { '1': 1 };
  const re = new RegExp('href="([^"]*\\/video\\/' + id + '\\/ep-(\\d+)\\/)"', 'gi');
  let m;
  while ((m = re.exec(html))) {
    if (!seen[m[2]]) {
      seen[m[2]] = 1;
      list.push({ ep: m[2], url: abs(m[1]) });
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

// 封面：原始二进制密文 -> AES-CBC 解密 -> 校验图片魔数后返回
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
  if (direct) {
    return new Response(bytes, { headers: { ...CORS, 'content-type': direct, 'cache-control': 'public,max-age=86400' } });
  }

  const plain = await aesDecrypt(bytes);
  const type = plain ? magic(plain) : '';
  if (plain && type) {
    return new Response(plain, { headers: { ...CORS, 'content-type': type, 'cache-control': 'public,max-age=86400' } });
  }
  return fallback();
}

// HLS/切片代理：重写 m3u8 内的分片与密钥地址，使其继续走本 Worker
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
      if (t.charAt(0) === '#') {
        return line.replace(/URI="([^"]+)"/gi, (whole, p1) => 'URI="' + rewrite(p1) + '"');
      }
      return rewrite(t);
    }).join('\n');

    return new Response(text, {
      headers: { ...CORS, 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' }
    });
  }

  return new Response(buf, {
    headers: { ...CORS, 'content-type': contentType || 'application/octet-stream', 'cache-control': 'public,max-age=3600' }
  });
}

async function handle(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url = new URL(request.url);
  const origin = url.origin;

  try {
    if (url.pathname === '/media') return media(url.searchParams.get('url'));
    if (url.pathname === '/raw') return proxyRaw(url.searchParams.get('url'), origin);
    if (url.pathname.indexOf('/api') !== 0) {
      return new Response('Huangguo Parser API', { headers: { ...CORS, 'content-type': 'text/plain;charset=utf-8' } });
    }

    const path = url.pathname.slice(4);

    if (path === '/') return json({ status: 'ok' });

    if (path.indexOf('/search/') === 0) {
      const keyword = decodeURIComponent(path.split('/')[2] || '');
      return json({ list: parseCards(await getText(SITE + '/search/video/' + encodeURIComponent(keyword) + '/')) });
    }

    if (path.indexOf('/detail/') === 0) {
      const id = path.split('/')[2];
      const html = await getText(SITE + '/video/' + id + '/');
      const title = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || id;
      return json({
        list: [{ vod_id: id, vod_name: title, vod_pic: imageProxy(coverOf(html)), episodes: parseEpisodes(id, html) }]
      });
    }

    if (path === '/play') {
      const page = decodeURIComponent(url.searchParams.get('url') || '');
      const ep = url.searchParams.get('ep') || '1';
      const html = await getText(page);
      const m = html.match(/id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i);
      let stream = '';
      if (m) {
        try {
          const data = JSON.parse(m[1]);
          stream = (data.epPlaySrcs && data.epPlaySrcs[ep]) || data.videoSrc || '';
        } catch (e) {}
      }
      if (!stream) {
        const mm = html.match(/https?:\/\/[^"'<>\s]+?\.m3u8(?:\?[^"'<>\s]*)?/i);
        if (mm) stream = mm[0];
      }
      return json({
        url: stream,
        proxy: stream ? origin + '/raw?url=' + encodeURIComponent(stream) : ''
      });
    }

    return json({ list: parseCards(await getText(SITE + (path || '/'))) });
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

addEventListener('fetch', (event) => event.respondWith(handle(event.request)));
