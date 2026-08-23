# 错题本（错词攻坚）— 设计文档

- **日期**：2026-08-23
- **状态**：已通过 brainstorming 确认，待编写实现计划
- **作者**：家长 + Claude（brainstorming）

## 1. 目标与背景

孩子背单词过程中答错的词散落在 SRS 状态里，没有一个专门的入口让孩子**主动攻克错词**。
本功能新增"错题本"：自动收集答错的词，孩子在首页点开即进入专门的错题练习会话，
反复练习直到连续答对 2 次毕业。

核心诉求：

1. 给**孩子**用（家长端错情分析不在本期范围）。
2. 错词进出错题本**全自动**，无手动管理。
3. 与现有 SRS / 星星体系**完全融合**，不搞双轨。

## 2. 已确认的决策

| 维度 | 决定 |
|---|---|
| 用途 | 孩子自主练错词；家长端分析不做 |
| 进入规则 | 任何入口（每日复习/单元学习/错题练习）答错即进本 |
| 毕业规则 | **连对 2 次**移出（`reps ≥ 2`），任何入口的作答都计数 |
| SRS 关系 | 错题练习完全走现有 SRS：对错更新间隔、答对计星星 |
| 方案 | **派生视图**（方案 B）：错题本成员资格从 `user_word_state` 实时派生，**不建状态表** |
| 时间线 | 现在就开始记**错拼事件表**（append-only），但 v1 展示从简 |
| 毕业后再错 | 自动重新进本，连对重新计 |

## 3. 方案选择：派生视图 + 事件表

### 为什么不建错题状态表

现有 `updateSrs`（src/srs.ts）的语义恰好就是错题本需要的全部状态机：

- 答错 → `reps=0, lapses+1`（连对清零、错次累计）→ **自动进本**
- 答对 → `reps+1`（连对累计）→ 达到 2 即**自动毕业**

因此 **"在错题本里" = `lapses > 0 AND reps < 2`**，一条 SQL 即可查出。
独立状态表（`wrong_count / correct_streak`）与派生逻辑完全同步演化，属冗余状态；
历史数据免费生效，无需数据迁移。

### 为什么要事件表

派生视图回答"谁在错题本里"，但不保留历史。唯一必须**现在**记的数据是错拼原文
（孩子当时拼成了什么，如 `applle`）——不记就永远丢。故加一张 append-only 事件表，
从上线起积累，为将来的错拼提示、攻克故事线、家长端分析留好数据（见 §9 扩展点）。

## 4. 数据模型

只加一张表，现有表零改动：

```sql
-- 错拼事件（append-only 日志，不参与判定）
CREATE TABLE wrong_answer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  answer TEXT,              -- 孩子当时拼的内容（客户端已 trim），缺失时 NULL
  source TEXT,              -- 作答入口 'daily' | 'unit' | 'mistake'，旧客户端缺失时 NULL
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wrong_events ON wrong_answer_events(user_id, word_id);
```

迁移：`migrations/0002_mistake_events.sql`；`test/schema.ts` 同步追加（该文件是迁移的
verbatim 副本，workerd 内无 fs，见文件头注释）。部署后在本地/远程各执行一次迁移。

## 5. 判定规则（零新逻辑，全部由现有 SRS 语义承载）

| 事件 | `user_word_state` 变化 | 错题本 |
|---|---|---|
| 任何入口答错 | `reps=0, lapses+1` | 进本（或已在册，错次+1） |
| 任何入口答对 | `reps+1` | `reps` 达 2 → 毕业 |
| 毕业后又错 | `reps=0, lapses+1` | 重新进本，连对重计 |

注意两个阈值并存，均为有意设计，勿混淆：

- **错题毕业**：`reps ≥ 2`（连对 2 次）
- **"已掌握"展示**：`reps ≥ MASTERY_REPS(3)`（现有逻辑，不动）

在册查询条件：`user_word_state WHERE user_id=? AND lapses > 0 AND reps < 2`。

## 6. API（src/kid.ts）

### POST /review 扩展（唯一改动点）

请求体新增**可选**字段：

- `source`：'daily' | 'unit' | 'mistake'，不在白名单或缺失时存 NULL
- `answer`：拼错的原文，超长（>100 字符）截断

行为：`correct=false` 时，在现有 SRS 更新与统计完成后**顺带**插一条
`wrong_answer_events`。事件写入 try/catch 包裹，失败仅 `console.log`，
**绝不影响 /review 的返回**（延续"进度优先、网络问题不打断孩子"哲学）。
`correct=true` 时不写事件。旧客户端不传新字段完全兼容。

### 新增 GET /api/session/mistakes?user_id=

错题练习队列：

```sql
SELECT w.id, w.term, w.pos, w.meaning_cn, w.example_en, w.example_cn,
       s.reps, s.interval_days, s.due_at, s.lapses
FROM user_word_state s JOIN words w ON w.id = s.word_id
WHERE s.user_id = ? AND s.lapses > 0 AND s.reps < 2
ORDER BY RANDOM()
```

返回形态与 `/session/due` 一致，前端可无缝复用。user_id 缺失 400；空本返回 `[]`。

### GET /home 扩展

响应新增 `mistake_count`：上述在册条件 `COUNT(*)`。

## 7. 前端（public/app.js + review-client.js）

### 首页

新卡片「📒 错题本」：显示在册词数。
`mistake_count = 0` 时显示"太棒了，没有错题！"，点击不进入会话。

### 错题练习会话

- 队列来自 `/api/session/mistakes`，**完全复用**现有拼写测试屏
  （判定反馈/逐字母高亮/TTS/动效/答错排队尾再试）。
- 上报 `source='mistake'`；答错时把拼错的原文放 `answer`。
- 每日复习、单元学习会话同样开始带 `source`（'daily' / 'unit'）。

### recordAnswer 扩展（review-client.js）

opts 新增 `source`、`answer`，透传进 `/review` 请求体。乐观上报机制不变。

### 会话小结：毕业统计

三种会话的小结统一新增"本次毕业 N 个词"。判定口径：
**会话开始时在册**（队列项 `lapses > 0 && reps < 2`）且**会话内 `reps` 达到 ≥ 2**
（以 /review 返回的 state 为准；上报失败的词不计数，非阻塞降级）。
这样已毕业的词在日常复习中继续答对不会重复计为"毕业"。

## 8. 错误处理

- 事件写入失败：`console.log` 记录（`wrangler tail` 可见），/review 正常返回。
- `/session/mistakes` 网络错：沿用现有 toast「网络出错了，再试一次」+ 重试。
- 空本：队列 `[]`，卡片文案引导（见 §7），无死链。
- 旧版缓存客户端：不传 `source/answer` → 事件行对应列 NULL，无兼容性破坏。

## 9. v1 范围边界（YAGNI，明确不做）

- ❌ 独立错词列表页 / 错词详情页（v1 只有"练习入口"）
- ❌ 错拼提示展示（"你上次拼成了…"）——数据已记，展示将来加
- ❌ 家长端错情分析（频次排行/趋势/错拼模式）
- ❌ 攻克墙 / 毕业勋章 / 周报
- ❌ 手动移出错词
- ✅ 扩展点：`wrong_answer_events` 从上线起积累，上述全部能力将来可纯增量实现

## 10. 测试（vitest + @cloudflare/vitest-pool-workers）

### 集成测试（test/api.test.ts 扩展）

1. 答错（带 source/answer）→ `/session/mistakes` 含该词；事件表新增一行，字段正确。
2. 三入口：同一词在 daily/unit/mistake 会话答错，`source` 分别记录正确。
3. 毕业：错 → 对 → 对 后不在队列；只对 1 次仍在册。
4. 毕业后再错 → 重新进本。
5. 空本 → `/session/mistakes` 返回 `[]`；`/home` 的 `mistake_count` 各场景计数正确。
6. 旧客户端 payload（无 source/answer）→ /review 正常，事件行对应列 NULL。
7. `answer` 超长截断；非法 `source` 存 NULL。

### review-client.test.ts 扩展

`recordAnswer` 把 `source` / `answer` 放进 /review 请求体；正确作答不带 `answer` 语义不受影响。

### 手工冒烟

`wrangler dev`：错一个词 → 首页错题本计数 +1 → 进错题练习连对两次 → 计数归零、小结显示毕业 1 个。
