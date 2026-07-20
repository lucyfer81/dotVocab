# dotVocab 双胞胎背单词应用 — 设计文档

- **日期**：2026-07-20
- **状态**：已通过 brainstorming 确认，待编写实现计划
- **作者**：家长 + Claude（brainstorming）

## 1. 目标与背景

给两个上三年级的双胞胎儿子做一个**简单有趣的英语单词背诵应用**。

核心诉求：

1. 部署在 Cloudflare **Worker** 上，用 **static assets**（不用 Pages）。
2. 数据保存在 **D1**。
3. 区分**两个孩子**各自的进度。
4. 用 **wrangler** 部署（已就绪：wrangler 4.112.0，已登录账号 `Lucyfer81@msn.com`）。
5. 单词按**课本 → 单元**组织；课本来源多，单词会重复，需能容纳重复。

## 2. 已确认的决策

| 维度 | 决定 |
|---|---|
| 主玩法 | **拼写输入**（给中文释义，拼英文；错拼逐字母高亮）|
| 进度模型 | **SRS 间隔重复**（每"孩子×单词"记间隔/到期/连对/遗忘次数）|
| 单词字段 | 英文 `term`、中文释义、词性、例句(英+中)；发音用浏览器 TTS |
| 录入方式 | **批量粘贴 CSV**（选课本+单元后批量导入），不依赖 LLM |
| 趣味性 | **轻度**：星星 + 每日连击 + 单元徽章；两孩子各自独立、不互比 |
| 架构 | **方案 A**：零构建 + 原生前端 + Hono，wrangler 自动打包 |
| 命名 | Worker 名 / D1 名 = `dotvocab`（取当前目录 `dotVocab` 小写化，符合 CF 命名规则）|

## 3. 架构（方案 A：零构建 + 原生前端）

### 项目结构
```
dotVocab/
├── wrangler.toml
├── package.json
├── src/
│   ├── index.ts          # Worker 入口：Hono 应用，挂载 /api/*；其余回落到静态资源
│   ├── api/              # API 路由（units, import, words, review, progress, users...）
│   ├── srs.ts            # 纯函数：间隔重复算法（易测试）
│   └── schema.sql        # D1 建表语句（参考）
├── public/               # 静态资源（assets 绑定）
│   ├── index.html        # 孩子端
│   ├── admin.html        # 家长端
│   ├── app.js / admin.js # 原生 JS 模块
│   └── style.css
├── migrations/           # D1 迁移
└── test/                 # vitest（至少覆盖 srs.ts + 关键 API）
```

### wrangler.toml（关键配置）
```toml
name = "dotvocab"
main = "src/index.ts"
compatibility_date = "2025-07-01"

[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "single-page_application"  # 客户端路由回落到 index.html

[[d1_databases]]
binding = "DB"
database_name = "dotvocab"
database_id = "<wrangler d1 create 后填入>"
```

### 请求分流
- `/api/*` → Hono 处理
- 其余路径 → assets 托管；未知路径回落 `index.html`（SPA）
- 发音：浏览器 `speechSynthesis`，纯前端，不经过 Worker

## 4. 数据模型（重点：重复词的容纳）

### 设计要点
单词**规范化去重**，单元与单词**多对多**，掌握度分**两层**：
- 第①层 **全局 SRS 掌握度**（`user_word_state`）：长期记忆，决定跨单元的"每日复习队列"。
- 第②层 **单元内覆盖记录**（`user_unit_word_seen`）：该词在该单元是否"至少测过一次"。

### 重复词处理逻辑（关键）
根据之前的掌握情况，重复词在新单元里**至少测试一次**：

- 打开某单元学习会话时，队列 = 本单元里 `user_unit_word_seen` **无记录**的所有词。
- 对每个词按"之前掌握情况"分别处理（见 §6 单元学习会话）。
- 测完写入覆盖记录；**全局 SRS 状态**按对错更新。
- 已掌握的词在每日复习队列里只由 `due_at` 驱动，不会因为出现在多个单元就被反复打扰。

### 建表 SQL
```sql
-- 课本单元（"课本 → 单元"组织维度）
CREATE TABLE units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book TEXT NOT NULL,            -- 如 "人教PEP三上"
  unit TEXT NOT NULL,            -- 如 "Unit 1"
  sort_key INTEGER DEFAULT 0,
  UNIQUE(book, unit)
);

-- 单词（规范化，term 唯一去重）
CREATE TABLE words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,     -- 小写英文，去重键
  pos TEXT,
  meaning_cn TEXT NOT NULL,
  example_en TEXT,
  example_cn TEXT,
  created_at INTEGER NOT NULL
);

-- 单元↔单词 多对多（同一词可属多个单元 = 重复词的安身处）
CREATE TABLE unit_words (
  unit_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  PRIMARY KEY (unit_id, word_id)
);

-- 两个孩子
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,     -- "哥哥"/"弟弟" 或真名
  avatar TEXT NOT NULL,          -- emoji
  pin TEXT                       -- 可选进入口令（默认空）
);

-- 第①层：每个孩子 × 单词 的全局 SRS 状态
CREATE TABLE user_word_state (
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  reps INTEGER DEFAULT 0,        -- 连续答对次数
  interval_days INTEGER DEFAULT 0,
  due_at INTEGER DEFAULT 0,      -- 下次到期 ms 时间戳
  lapses INTEGER DEFAULT 0,
  last_reviewed_at INTEGER,
  PRIMARY KEY (user_id, word_id)
);

-- 第②层：单元内覆盖记录（该词在该单元是否至少测过一次）
CREATE TABLE user_unit_word_seen (
  user_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  first_seen_at INTEGER,
  PRIMARY KEY (user_id, unit_id, word_id)
);

-- 星星 / 连击
CREATE TABLE user_stats (
  user_id INTEGER PRIMARY KEY,
  stars INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  last_play_date TEXT            -- "YYYY-MM-DD"
);
```

**重复词举例**：导入"人教三上 Unit 1"含 `apple`，再导入"外研三上 Unit 3"也含 `apple` → `words` 表 `apple` 只有一行；`unit_words` 两条记录分别指向两个单元。孩子打开外研那个单元时，`apple` 因 `user_unit_word_seen` 无记录而**进入本单元队列被测一次**（即便全局已掌握）；测对则覆盖记录写入、全局间隔继续增长。

## 5. SRS 算法（`src/srs.ts`，纯函数）

间隔阶梯（天）：`INTERVALS = [0, 1, 2, 4, 8, 16, 30, 60]`

```
输入：当前 state {reps, interval_days, due_at, lapses}、本次 correct(true/false)、now
correct : reps += 1
          interval_days = INTERVALS[min(reps, 末位)]
          due_at = now + interval_days * 1天
wrong   : reps = 0
          interval_days = 0
          lapses += 1
          due_at = now          -- 本会话内还会排到队尾再试一次
```

- **提示按钮**：显示首字母。用了**不扣 SRS**，但本次不计星星。SRS 只看拼写对错。
- **发音**：`speechSynthesis`（lang=en-US）。拼写模式下题目不自动播放（否则等于念答案），答完再播，另有 🔊 可重听。无英文语音时静默降级。

## 6. 孩子端界面流程

### 首页（选身份后）
- 头像 + 🔥连击天数 + ⭐星星
- 「今日复习」卡：跨单元、`due_at ≤ now` 的词数 → 点开做每日复习
- 「按课本学」卡：课本 → 单元（显示进度%）→ 进单元学习
- 「切换用户」按钮（始终可见）

### 每日复习会话
- 拉取所有到期词，逐个拼写测试，更新 SRS、发星，结束给小结。

### 单元学习会话（"至少测一次"落地处）
- 队列 = 本单元里 `user_unit_word_seen` 无记录的词，按 `sort_key` 排序。
- 每个未覆盖词：
  - 全局新词（无 `user_word_state`）→ 先看**词卡**（英文+中文+词性+例句+🔊），点"开始拼写"再测
  - 全局已掌握 → 直接到**快速确认测试**
  - 测完 → 写入 `user_unit_word_seen`（覆盖）→ 更新 SRS
- 进度% 实时刷新；到 100% → 发"单元徽章"+ 星星奖励。

### 拼写测试屏
- 上方：中文释义(+词性)、例句(可折叠)
- 下方：输入框；提交（Enter 或按钮）
- 对✅：绿 + ⭐ + 发音，下一题
- 错✗：逐字母高亮（对/错/缺）+ 显示正确拼写 + 发音 + 排到队尾"再来一次"，下一题
- 顶部：会话进度条

## 7. 趣味性（轻度）

- ⭐ **星**：干净拼对一个 +1，存 `user_stats.stars`。
- 🔥 **连击**：当日完成至少一次测试（每日复习或单元学习都算）即算"今日已练" → 连续多日则连击 +1/日；断一天归零（按 `last_play_date` 判定：昨天的日期→+1，今天已记→不变，更早→重置为 1）。
- 🏅 **单元徽章** v1：可从"单元覆盖率 = 100%"直接派生，**不单独建表**。星星/连击里程碑先只展示数值。

## 8. API（Hono，`/api/*`）

```
孩子端
GET  /api/users                              列出两个孩子
GET  /api/home?user_id=                      首页聚合：连击/星星/今日到期数/各单元进度
GET  /api/session/due?user_id=               每日复习队列（词内容+state）
POST /api/review {user_id,word_id,correct}   更新SRS，返回新state/星星/连击
POST /api/session/unit {user_id,unit_id}     取单元学习队列
POST /api/cover    {user_id,unit_id,word_id} 标记单元内已覆盖

家长端（ADMIN_TOKEN 鉴权中间件）
GET/POST /api/admin/units
POST   /api/admin/import {unit_id,csv}       解析+upsert words+挂单元，返回{新增,更新,已挂,错误[]}
GET/PUT/DELETE /api/admin/words/:id
GET    /api/admin/progress                    两孩子总览
```

### 鉴权
- 孩子端：无真实登录，选头像 → `user_id` 存 localStorage（可设可选 PIN）。
- 家长端：环境变量 `ADMIN_TOKEN`，登录后存 localStorage，请求带 header。

### CSV 导入格式
每行一个词：`english,词性,中文释义,例句英,例句中`（逗号或 Tab 分隔）。
导入流程：英文小写归一 → upsert 到 `words`（`ON CONFLICT(term)`）→ `INSERT OR IGNORE` 挂到单元 → 返回"新增 X / 更新 Y / 已挂 Z / 错误行[]"。

## 9. 错误处理

- **API 统一**：Hono 全局错误中间件 → JSON `{error}`，状态码 400/404/401/500。D1 异常 try/catch、`console.log` 记录（`wrangler tail` 可看）。
- **CSV 导入**：行级容错——坏行不中断整体导入，收集"第 N 行：xxx 错误"返回；空行/缺中文释义跳过。
- **前端**：网络错 → 中文 toast「网络出错了，再试一次」+ 重试；空状态友好引导（无到期词 →「今天没有要复习的，去学新课吧」）。
- **身份**：home 应用无真实鉴权，`user_id` 信任客户端；接口仍校验 user/word 存在性，防脏数据。

## 10. 测试

- `vitest` + `@cloudflare/vitest-pool-workers`（Miniflare 本地 D1）：
  - `srs.ts` 单测：对/错转移、间隔阶梯推进、新词与封顶边界
  - 集成测试：导入去重、复习更新 SRS、单元覆盖逻辑、**重复词跨单元"至少测一次"**
- 手工冒烟：`wrangler dev` 本地跑通两个孩子的完整流程

## 11. 部署落地步骤

1. `npm init` + 装依赖：`wrangler`、`hono`；dev：`vitest`、`@cloudflare/vitest-pool-workers`
2. `wrangler d1 create dotvocab` → 把 `database_id` 填进 `wrangler.toml`
3. 写迁移 `migrations/0001_init.sql`（含两张 user 预置数据：哥哥/弟弟）
4. 本地：`wrangler d1 execute dotvocab --local --file=migrations/0001_init.sql`
5. `wrangler dev` 本地冒烟 → 调通
6. 上线：`wrangler deploy`
7. 远程库执行迁移：`wrangler d1 execute dotvocab --remote --file=migrations/0001_init.sql`
8. 设密钥：`wrangler secret put ADMIN_TOKEN`

本地数据存 `.wrangler/state`，`wrangler dev` 自动带本地 D1。

## 12. v1 范围边界（YAGNI，明确不做）

- ❌ 配图、音标（已决定不要）
- ❌ 徽章墙 / 排行榜 / 双胞胎 PK（轻度趣味即可）
- ❌ 真实账号鉴权、AI 补全导入、真人录音
- ✅ 留好扩展点：词表已规范、SRS 纯函数、徽章可后加表
