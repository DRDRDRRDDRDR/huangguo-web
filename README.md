# 黄果解析站

基于 [jinshengchan/huangguo-fongmi](https://github.com/jinshengchan/huangguo-fongmi) 与 [cluntop/tvbox](https://github.com/cluntop/tvbox)（`js/ss/huangguo.py`、`js/ss/huangguo2.py`）的适配逻辑实现。前端部署到 GitHub Pages，API 与跨域代理部署到 Cloudflare Workers 免费档。

## 地址

- 站点：https://drdrdrrddrdr.github.io/huangguo-web/
- Worker API：https://huangguo-parser.13681235735.workers.dev

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/` | 服务状态 + 分类与排序枚举 |
| GET | `/api/categories` | 分类、排序、榜单、吃瓜枚举 |
| GET | `/api/all` | 首页聚合（推荐 + 榜单 + 话题 + 吃瓜） |
| GET | `/api/category/{tid}?page&size&sort` | 分类列表，`tid` = `ai-duanju` / `ai-manju` / `ai-huanlian` / `ai-mogai` |
| GET | `/api/ranks/{type}?page&size` | 排行榜，`type` = `hot` / `recommend` / `potential` |
| GET | `/api/topics` | 话题专辑列表 |
| GET | `/api/topics?slug={slug}&size` | 话题专辑内视频 |
| GET | `/api/chigua?cate&page&size` | 黄果吃瓜，`cate` = `all` / `remen` / `yuanchuang` |
| GET | `/api/search/{关键词}?page&size` | 搜索 |
| GET | `/api/detail/{id}` | 详情 + 剧集列表 |
| GET | `/api/play?url&ep` | 解析 m3u8 播放地址 |
| GET | `/media?url` | 封面解密代理 |
| GET | `/raw?url` | HLS 分片与密钥代理 |
| GET | `/hls.js` | 播放器库代理 |

## 关键实现说明

1. **官方 JSON 接口优先**：`/api/videos/category/...`、`/api/ranks/...`、`/api/videos/{id}`、`/api/topics`、`/api/search` 比 HTML 抓取更可靠，并带分页元数据、评分与标签；HTML 抓取仅作兜底。
2. **封面是加密二进制**：站点封面响应为 AES-CBC 加密的**原始二进制**（不是 base64 文本），密钥 `f5d965df75336270`、IV `97b60394abc2fbe1`。Worker 按二进制解密后校验 JPEG/PNG/WebP/GIF 魔数再返回。
3. **卡片解析按容器切片**：以 `hg-drama-card` 为边界，并排除 `cover-placeholder.png` 占位图与统计像素，避免串图。
4. **HLS 必须用 hls.js**：Chrome / Edge 的 `<video>` 原生不支持 m3u8，且该源为 AES-128 加密切片，因此前端使用 hls.js，并通过 `/raw` 代理重写分片与密钥 URI，播放器库本身也由 `/hls.js` 代理以避免公共 CDN 不可达。

## 本地预览

```bash
python -m http.server 8080
```

## Worker 部署

```bash
npx wrangler deploy
```

站点内容来自第三方公开站点，使用者需自行遵守当地法律法规与版权规则。
