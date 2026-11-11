# 黄果解析站
# 好用的话给DR点个Star好吗秋梨膏！
# 到底是谁在用爬虫爬我这里数据 后端接口要爆了宝宝，你去爬源站不好吗，已加反爬

基于 [jinshengchan/huangguo-fongmi](https://github.com/jinshengchan/huangguo-fongmi) 与 [cluntop/tvbox](https://github.com/cluntop/tvbox)（`js/ss/huangguo.py`、`js/ss/huangguo2.py`）的适配逻辑实现。前端部署到 GitHub Pages，API 与跨域代理部署到 Cloudflare Workers 免费档。

## 页面结构

| 页面 | 说明 |
|---|---|
| `index.html` | **首页：全部剧集**（分类 + 排序 + 搜索，滚动自动加载，每批 50 部） |
| `play.html` | **独立播放页**（`?id={ID}&ep={集数}`）：播放器 + 剧集信息 + 选集 + 上一集/下一集 + 相关推荐 + 片源完整性提示 |
| `ranks.html` | 排行榜（热播榜 / 推荐榜 / 潜力榜） |
| `topics.html` | 专辑专题 |
| `chigua.html` | 黄果吃瓜 |
| `api.html` | 接口列表（每行可点击直接测试） |

所有列表页统一 **每批 50 条**（`PAGE_SIZE = 50`，定义在 `app.js`），滚动到底部自动加载。

## 地址

- 首页：https://drdrdrrddrdr.github.io/huangguo-web/
- 播放页：https://drdrdrrddrdr.github.io/huangguo-web/play.html?id=7460&ep=1
- Worker API：https://huangguo-parser.13681235735.workers.dev

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/` | 服务状态 + 分类与排序枚举 |
| GET | `/api/categories` | 分类、排序、榜单、吃瓜枚举 |
| GET | `/api/all` | 首页聚合 |
| GET | `/api/category/{tid}?page&size&sort` | 分类列表，`tid` = `ai-duanju` / `ai-manju` / `ai-huanlian` / `ai-mogai` |
| GET | `/api/ranks/{type}?page&size` | 排行榜，`type` = `hot` / `recommend` / `potential` |
| GET | `/api/topics` / `/api/topics?slug={slug}` | 话题专辑列表 / 专辑内视频 |
| GET | `/api/chigua?cate&page&size` | 黄果吃瓜，`cate` = `all` / `remen` / `yuanchuang` |
| GET | `/api/search/{关键词}?page&size` | 搜索 |
| GET | `/api/detail/{id}` | 详情 + 剧集列表 |
| GET | `/api/play?url={id或页面地址}&ep={集数}` | 播放解析（含片源完整性校验） |
| GET | `/media?url` | 封面解密代理 |
| GET | `/raw?url` | HLS 分片与密钥代理 |
| GET | `/hls.js` | 播放器库代理 |

### `/api/play` 返回字段

```json
{
  "url": "m3u8 原始地址",
  "proxy": "/raw 代理地址",
  "id": "7460", "ep": "1", "title": "第1集",
  "source": "api",
  "declaredDuration": 240,
  "actualDuration": 54,
  "segments": 7,
  "keyMethod": "AES-128",
  "incomplete": true
}
```

`incomplete: true` 表示**源站下发的 m3u8 实际时长明显小于接口声明时长**，即源站对当前请求只给了占位/预览片段。播放页会据此显示醒目提示，避免被误判为本站解析错误。

## 关键实现说明

1. **官方 JSON 接口优先**：`/api/videos/category/...`、`/api/ranks/...`、`/api/videos/{id}`、`/api/videos/{id}/play`、`/api/topics`、`/api/search`；HTML 抓取仅作兜底，响应的 `source` 字段标明来源。
2. **播放解析用官方接口**：`/api/videos/{id}/play?ep=N` 返回 `video_url`、`duration`、`title`、`ep_num`，比读页面 `videoInitialData` 更规范；页面数据仅作兜底。
3. **封面是加密二进制**：封面响应为 AES-CBC 加密的**原始二进制**（不是 base64 文本），密钥 `f5d965df75336270`、IV `97b60394abc2fbe1`；Worker 按二进制解密后校验 JPEG/PNG/WebP/GIF 魔数再返回。
4. **解析按容器块边界切分**：以 `hg-drama-card` / `hg-rank-item` / `hg-post-card` 为边界，**不使用字符窗口**，避免跨卡片串行。
5. **名称统一**：`cleanTitle()` 剥离 `sr-only` 辅助文本、站点后缀、`黄果吃瓜侠·日期·分类` 前缀；剧集标题一律规范为「第N集」。
6. **HLS 必须用 hls.js**：Chrome / Edge 的 `<video>` 原生不支持 m3u8，且该源为 AES-128 加密切片；播放页用 hls.js，通过 `/raw` 重写分片与密钥 URI，播放器库由 `/hls.js` 代理。

## 关键事实：CDN 按「请求出口 IP」下发不同播放列表

这是本项目最重要的一条实测结论，**不要把它当成源站 bug 或本站解析错误**：

| 请求出口 | m3u8 时长 | 分片数 | 说明 |
|---|---:|---:|---|
| **住宅 / 移动 IP（用户浏览器）** | **240s** | **42** | 完整片源 |
| Cloudflare Worker（数据中心 IP） | 54s | 7 | 预览片段 |

同一个 `video_url`、同一份签名，仅因**出口 IP 不同**，CDN 返回不同播放列表。实测对照：

```
Worker /api/play 返回的 url
  ├─ 用住宅 IP 取  → 240s / 42 片  ✅
  └─ 经 Worker 取  →  54s /  7 片  ❌
```

因此播放页的正确做法是 **浏览器直连原始 m3u8**（出口=用户真实 IP），而不是走 Worker 代理。
`/api/play` 会返回 `preferDirect: true` 与 `url`（原始地址）、`proxy`（兜底地址）；
前端优先用 `url` 直连，仅在直连失败时才回退 `proxy`。

`workerProbe` 字段是 **Cloudflare 出口的观测值**，只用于诊断，
**绝不能**用来判定用户能否完整播放。

### 跨域可用性（实测）

m3u8、密钥（`crypt.key`）、ts 分片**全部返回 `Access-Control-Allow-Origin: *`**，
因此浏览器可跨域直连，无需代理。抽查结果：

```
m3u8      status=200  ACAO=*  240s / 42 片 / EXT-X-ENDLIST
crypt.key status=200  ACAO=*  len=16
#0  ts    status=200  ACAO=*  3,546,816 B
#21 ts    status=200  ACAO=*  3,435,328 B
#41 ts    status=200  ACAO=*     52,080 B
```

## 本地预览

```bash
python -m http.server 8080
```

## Worker 部署

```bash
npx wrangler deploy
```

站点内容来自第三方公开站点，使用者需自行遵守当地法律法规与版权规则。
## 2026-11-11 重大更新：源站迁移 + 加密接口

### 源站域名变更

`huangguoai.com` 已不可达，DNS 被污染到 Facebook 网段，直连与 DoH 均超时。
官方入口页 `huangguoai.ai` 公布的新地址中，**`huangguoai.io` 接口结构完全一致**，已改为主用。
封面 CDN 也从 `pic.wirqed.cn` 换成了 `pic.drleao.cn`，AES-CBC 解密逻辑不变。

### 接口全面加密：dx150-edge-v1

站点 2026-11-09 起把业务接口迁到加密通道，旧的 `/api/videos/{id}/play` 返回的 `video_url` 恒为空，
这正是「解析不了」的直接原因。协议如下：

1. 握手 `POST /api/playback/request`，body 为 `{v:1, type:'hello', client_pub:<base64url ECDH P-256 公钥>}`
2. 服务端返回 `server_pub`、`salt`、`kid`、`sid`、`server_time`、`expires_at`
3. ECDH 协商出共享密钥，经 HKDF-SHA256 按 `dx150-edge-v1\n<scope>\n<site>\n<kid>\n<sid>\n<req|res>` 派生双向 AES-GCM 密钥
4. 业务请求封装为 `{method, path, body:<base64>, content_type, visitor_id}`，加密后包成
   `{v:1, type:'call', kid, sid, seq, ts, ciphertext}` 发出，响应同样加密返回内层 HTTP 结果

**播放地址的正确取法**：`POST /api/videos/{id}/episodes/{ep}/playback`，解密后得到
`data.streams.main`，实测第 1 集 240 秒 / 42 分片，带 `via_m=dx150` 签名。

### 多 Worker 分流

部署了 3 个功能完全相同的 Worker，前端按「轮询起点 + 失败自动切换」分散请求：

| Worker | 地址 |
|---|---|
| 主 | https://huangguo-parser.13681235735.workers.dev |
| 2 | https://hg-parser-2.13681235735.workers.dev |
| 3 | https://hg-parser-3.13681235735.workers.dev |

`app.js` 里的 `API_ENDPOINTS` 数组维护这份清单，某个端点失败会记冷却时间并自动跳过，
封面图片用「最近一次成功的端点」拼接，避免全部压在同一个 Worker 上。

## 本地预览

```bash
python -m http.server 8080
```

## Worker 部署

```bash
npx wrangler deploy
```

站点内容来自第三方公开站点，使用者需自行遵守当地法律法规与版权规则。

## 反爬防护

爬虫直接打 API 会迅速耗尽 Worker 免费档每天 10 万次请求，因此加了三层防护，全部在 Worker 的 `handle` 入口执行。

**第一层 浏览器指纹**。检查 `User-Agent`、`Referer`、`Origin`、`Sec-Fetch-*`。明确的脚本特征直接拒绝，包括 `curl`、`wget`、`python-requests`、`aiohttp`、`httpx`、`scrapy`、`go-http-client`、`okhttp`、`node-fetch`、`undici`、`postmanruntime`，以及 `headlesschrome`、`puppeteer`、`playwright`、`selenium`。浏览器跨域请求必然带 Referer 或 Origin，纯脚本客户端通常没有。

**第二层 时间窗口 HMAC**。前端每次请求生成 `X-HG-Ts` 与 `X-HG-Sig`，签名内容是 `窗口号 + path + query`，窗口 5 分钟，前后各容忍一个窗口。爬虫必须真正执行 JS 并复刻签名算法才能通过。密钥写在前端，目的是挡住不执行 JS 的批量脚本，不是对抗有意的逆向。

**第三层 Cache API**。读接口按内容类型缓存，命中后直接返回不打源站：分类 5 分钟、排行榜 10 分钟、话题与吃瓜 15 分钟、详情 10 分钟、搜索 3 分钟、健康检查 1 小时。播放地址因签名有时效不缓存。

**免防护路径**：`/api/` 与 `/api/categories` 用于探活和枚举，不含业务数据，不校验签名；`/media`、`/raw`、`/hls.js` 由 `<img>` 与 `<video>` 直接发起，不带自定义头，也不设防。

**实测结果**：正常浏览器五项接口全部 200；无签名、python-requests、curl、headless、无 Referer 五种爬虫场景全部 403；过期签名返回 `sig:expired`。

注意 `CORS` 需要放行 `X-HG-Ts` 与 `X-HG-Sig`，否则浏览器预检会失败，这是最容易漏的一环。

## 无感人机验证

在不引入 Cloudflare Turnstile 的前提下，用交互信号打分加 HMAC 票据实现静默验证，用户全程零操作。

前端 `app.js` 在页面加载后后台采集六类信号：页面停留时长、指针移动次数、轨迹抖动、事件间隔离散度、硬件并发数、时区。指针轨迹的方差是关键判据，真人轨迹有非零抖动，脚本常是匀速直线或零位移。

攒够信号后静默 POST `/api/challenge`。Worker 打分，满分 100，阈值 70。达标则签发 proof，格式为 `窗口号.HMAC`，有效期 30 分钟，绑定 UA 与 Accept-Language 的指纹。业务请求带 `X-HG-Proof`，服务端验签，伪造或过期一律 403。

指纹刻意不绑 IP。移动网络切换与代理会让出口 IP 漂移，绑 IP 会把正常用户误杀，这是实测踩到的坑。

部署瞬间的兼容处理：未携带 proof 的请求按宽容放行，带了就必须有效。这样老缓存页面的用户不会在发布那一刻被整体拒绝，前端静默换到 proof 后自动进入严格模式。

实测：真实信号签发 100 分 proof，带 proof 访问业务接口 200；空信号、全零伪造、匀速无抖动轨迹三种场景全部 403；伪造 proof 403。
