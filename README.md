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

## MCP 接入说明

前端默认不会批量请求 MCP。`src/utils/sellerspriteMcp.ts` 会优先寻找：

1. `window.__SELLERSPRITE_MCP__`
2. `window.sellerspriteMcp`
3. `VITE_SELLERSPRITE_MCP_ENDPOINT`

没有桥接时，页面会显示清晰错误，不会崩溃。

## 本地运行

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```
