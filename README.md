# amazon-sellersprite-selector

Amazon 铺货 / 精铺选品工具，第一版聚焦「MCP 单品验证」。

## 当前能力

- 单 ASIN 查询入口：ASIN 详情、销量趋势、流量关键词统计。
- 单关键词查询入口：关键词搜索量、购买量、PPC、竞争度字段。
- 字段可用性检查：区分可用、未返回、需要人工补充、需要前台复核。
- 铺货模型诊断：低评论出单、价格压制、平台后毛利率、低竞价广告捡漏。
- raw response 保留：方便后续确认卖家精灵 MCP 的真实字段结构。
- 商品列表跳转：只填充 ASIN，不自动调用 MCP，避免额度消耗。
- 人工成本录入：采购、头程、包装、其他成本、人工 FBA 费用。
- 毛利率测算：目标降价后自动计算平台后毛利率与最终毛利率。
- 本地候选记录：把单品验证结果保存到浏览器本地，便于继续复核。
- MCP 回填商品：手动把单品验证结果保存到当前商品或候选商品。
- 铺货捡漏评分：按低评论出单、价格压制、全成本毛利、低竞价广告、安全风险重新打分。
- 商品详情对比：保留 Excel 原始数据和 MCP 最新数据，并显示关键字段差异。
- 前台复核闭环：人工记录价格、评论变体、页面弱点、竞争风险和广告切入点。
- 最终决策卡片：合并 Excel 初筛、MCP 复核、前台复核和利润测算，输出开发、小测、等待或放弃。

## MCP 接入说明

前端默认不会批量请求 MCP。单次查询默认走本地桥接：

1. `npm run dev` 会同时启动页面和 `scripts/sellersprite-bridge.mjs`。
2. 本地桥接默认读取当前电脑的 `~/.codex/config.toml` 中 `sellersprite-mcp` 配置。
3. 前端只访问 `/api/sellersprite/call`，不会拿到卖家精灵授权头。

浏览器查询封装仍保留其他接入方式，会按顺序寻找：

1. `window.__SELLERSPRITE_MCP__`
2. `window.sellerspriteMcp`
3. `VITE_SELLERSPRITE_MCP_ENDPOINT`
4. 本地 `/api/sellersprite/call`

如果桥接没有启动、Codex 中没有卖家精灵 MCP 配置，或授权失效，页面会显示清晰错误，不会崩溃。

也可以用环境变量覆盖本地配置：

```bash
SELLERSPRITE_MCP_URL="https://mcp.sellersprite.com/mcp" \
SELLERSPRITE_MCP_SECRET_KEY="你的 secret-key" \
npm run dev
```

## 本地运行

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```
