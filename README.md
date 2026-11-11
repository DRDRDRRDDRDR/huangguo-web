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
