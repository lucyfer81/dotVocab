# URL 直达账号（/xct /lcl）— 设计文档

- **日期**：2026-11-22
- **状态**：已通过 brainstorming 确认，待编写实现计划
- **作者**：家长 + Claude（brainstorming）

## 1. 目标

两个固定账号通过专属 URL 直接进入各自页面，跳过选人步骤：

- `https://vocab.aizhi.app/xct` → 哥哥的首页
- `https://vocab.aizhi.app/lcl` → 弟弟的首页

只有这两个用户，不会开放给别人，无需通用账号系统。

## 2. 方案：纯前端硬编码（已选）

代号到用户的翻译只发生在前端启动时，**后端、数据库、migration 零改动**：

```
打开 /xct → 前端读 URL 得代号 xct
          → 调现有 GET /api/users
          → 按硬编码对照（xct→"哥哥"）按名字匹配，拿到真实 user_id
          → 之后所有请求照旧带 user_id（数据库只认识 user_id）
```

落选方案：A（users 表加 slug 列，数据驱动，但需要 migration，对本需求过度）、
C（Worker 注入身份 cookie，过度设计）。

## 3. 前端改动（public/app.js + 新模块）

### 新模块 public/user-routing.js

对照表 + 解析函数，独立成模块便于单元测试（惯例同 spell-helpers.js）：

- `SLUG_BY_NAME = { "哥哥": "xct", "弟弟": "lcl" }`
- `nameForSlug(slug)`：代号 → 用户名；未知代号返回 null
- `resolveUser(slug, users)`：从 `/api/users` 结果里按名字找用户；
  名字不存在时返回 null（**绝不模糊匹配或回退到另一个人**）

### boot 流程改造（app.js）

| URL 路径 | 行为 |
|---|---|
| `/xct`、`/lcl`（忽略大小写与尾斜杠） | 解析用户 → 进对应孩子首页 |
| `/xct` 但数据库里匹配不到"哥哥" | **明确报错页**：「找不到用户，请从 / 进入」 |
| `/`（根路径） | 保留「选择宇航员」选择页 |
| 其他未知路径（如 `/foo`） | 显示选择页（宽容处理） |

### 选择页与切换用户

- 选择页点卡片 → `location.href = /xct` 或 `/lcl`（按名字反查对照表）
- 首页「切换用户」按钮 → 跳回 `/`

### localStorage 记忆删除

URL 成为身份的唯一来源，删除 `dotvocab_user` 记忆机制；
boot 时顺手 `removeItem` 清掉旧浏览器里的残留。

## 4. 不改的东西

- 后端 API、D1 数据库、migration、admin 端：零改动
- `wrangler.toml` 的 SPA 兜底已让 `/xct` `/lcl` 返回 index.html，无需新路由
- `manifest.json`：`start_url: "/"` 不动（iPad Safari 加主屏用当前页 URL，
  加 `/xct` 到主屏即直达哥哥）

## 5. 防呆底线

硬编码映射最大的风险是**静默错人**（数据库名字变了，弟弟被当成哥哥）。
守住两条：

1. 匹配不到 → 明确报错页，绝不回退、绝不猜
2. 代号只认全等比较（trim + 小写规范化后），不做前缀/模糊匹配

## 6. 测试

- 单元测试（新）：`test/user-routing.test.ts` 或 `.js`——
  代号↔名字对照、大小写/尾斜杠规范化、未知代号、名字缺失返回 null
- 手工冒烟（`wrangler dev`）：
  `/xct` 进哥哥、`/lcl` 进弟弟、`/` 选择页点卡片跳转、
  未知路径显示选择页、切换用户回 `/`、复习一题确认 user_id 归属正确
- 现有 API 集成测试不受影响（后端零改动）
