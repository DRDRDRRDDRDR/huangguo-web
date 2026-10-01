# 黄果解析站

基于 [jinshengchan/huangguo-fongmi](https://github.com/jinshengchan/huangguo-fongmi) 的站点解析逻辑，前端部署到 GitHub Pages，API 与跨域代理部署到 Cloudflare Workers 免费档。

## 地址

- GitHub Pages：启用 Actions 后，地址为 `https://drdrdrRddrdr.github.io/huangguo-web/`（以仓库 Settings > Pages 显示为准）
- Worker API：`https://huangguo-parser.13681235735.workers.dev`

## 本地预览

直接打开 `index.html` 可能受浏览器跨域策略影响，建议使用任意静态服务器：

```bash
python -m http.server 8080
```

## Worker 部署

```bash
npx wrangler deploy
```

Worker 通过服务端抓取 `huangguoai.com`，提供首页、分类、搜索、详情、播放地址解析和封面解密代理。站点内容来自第三方公开站点，使用者需自行遵守法律法规与版权规则。
