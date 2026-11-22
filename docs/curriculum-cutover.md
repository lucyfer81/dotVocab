# 教材换库（cutover）操作手册

由 `docs/superpowers/plans/2026-11-22-shared-pool-fsrs.md` 任务 8 产出。给出可重复的
**预演、对账、回退**步骤。配套自动化验证：`test/cutover.test.ts`（端到端夹具，把本手册
第 2/3 节的关键断言钉进 CI 级测试）与 `test/curriculum-migration.test.ts`（表级语义）。

> **账本 Ruling（开工时已定，全文最优先）**
> 仅在**隔离测试副本**执行清零演练——产品允许重置，但线上操作独立。
> **本次工程不做任何生产库操作；正式切换需另行安排**，届时按本手册逐步执行并逐项签核。

---

## 0. 安全约定（先读）

本手册所有命令使用占位符，**绝不内置生产库名/ID**。执行前必须：

| 占位符 | 含义 | 确认方式 |
|---|---|---|
| `<生产库名>` / `<生产库ID>` | 线上 D1 数据库 | `npx wrangler d1 list` 人工核对名称与 ID |
| `<演练库>` | 隔离副本（本地 sqlite 文件或一次性演练 D1） | 确认其 ID ≠ 生产库 ID |
| `<备份文件>` | `backups/` 下的导出 SQL | 核对文件名中的时间戳 |
| `<旧部署版本>` | 切换前正在服役的 Worker 版本 | `npx wrangler deployments list` |
| `<时间戳>` | `YYYYMMDD-HHMM`（UTC） | — |

三条铁律：

1. 任何 `--remote` 命令执行前，先 `npx wrangler d1 list` 并**口头复述目标库**，第二人确认；
2. 不把生产库名/ID 写进脚本、CI、shell 历史；一次性命令手工执行；
3. 本地验证一律用 `/tmp/opencode` 下的文件或 `--local` 副本，不建常驻"练习库"冒充隔离。

---

## 1. 换库语义：什么是一次性的，什么是幂等的

- **一次性切换** = `migrations/0003_curriculum_daily.sql`：建 8 张新表（curriculum 三表 +
  pool_units/user_quotas/user_cards/daily_lists/daily_items/answer_events），末尾 4 条
  `DELETE`（`user_word_state`、`user_unit_word_seen`、`wrong_answer_events`、`user_stats`）。
  生产 D1 由 `d1_migrations` 表记录已应用版本，**天然只跑一次**；任何时候都不要手工重放
  这段 DELETE。
- **幂等装载** = `node scripts/build-curriculum-sql.mjs` 的产物：对 curriculum_units /
  curriculum_senses / curriculum_unit_senses 做 `ON CONFLICT DO UPDATE` upsert，
  **不写 pool_units、不碰任何个人状态表**。因此：换库后重复导入教材（改错、补词）不会
  触发重置，孩子的卡片/星星/清单原样保留。
- **换库效果**（`test/cutover.test.ts` 已自动化钉住）：账号保留；卡片、到期日、覆盖记录、
  错词、星星、连续学习天数一次性清零；共享池为空；不做旧词匹配或历史迁移。两人从零开始，
  空池打开返回 `emptyReason=no_open_units`，加池后首份清单全为新词。

---

## 2. 预演（隔离副本）——可重复清单

> 全程在副本上操作。副本来源二选一：生产导出文件回放进一次性演练库（最接近真实），
> 或 `wrangler d1 execute <演练库> --local` 的本地库。演练库用完即弃。

1. **取副本**：`npx wrangler d1 export <生产库名> --remote --output /tmp/opencode/rehearsal-src-<时间戳>.sql`
   （预演生产数据时才需要；纯流程预演可用空库 + 手工种子）。
2. **建演练库**：新建本地 sqlite 文件（`sqlite3 /tmp/opencode/rehearsal-<时间戳>.db`）或
   `npx wrangler d1 create <演练库名>`；回放副本并确认 `users`、旧进度行数与源一致。
3. **迁移**：对演练库应用 0001→0003（`wrangler d1 migrations apply <演练库> --local` 或
   逐文件 execute），确认 `d1_migrations` 有 0003 记录、旧四表已清零、新表已建。
4. **装载教材**：`node scripts/build-curriculum-sql.mjs > /tmp/opencode/curriculum-<时间戳>.sql`
   → execute 进演练库（重复执行一次验证幂等）。
5. **数量对账**（见第 6 节 SQL）：52 单元 / 722 词义 / 903 关联；再跑
   `node scripts/build-curriculum.mjs --check` 确认 books.json 与词表源一致。
6. **切换验证**：两人从零开始、空池无任务、加池后首份清单全为新词、次日复习+新词
   （自动化版本即 `npm test -- test/cutover.test.ts`；演练库上可用页面/接口复验一遍）。
7. **并发冒烟**（账本任务 6 提醒）：对演练库起本地 Worker（`npx wrangler dev --local`
   + 指向演练库的配置），先 SQL 直插当日清单与一条 pending 条目，再**并发**发两个
   `POST /api/daily/answer`（同一 itemId，一个正确答案一个错误答案）：
   验证 `answer_events` 恰一条带 rating、`user_cards` 恰一行、条目 status 只被推进一次。
8. **回退演练**：在第 3 步前先存"备份点"（副本文件即备份）；演练回退 = 丢弃演练库当前
   状态、从备份点重新回放，核对第 2 步的行数逐一相符。
   - **⚠️ WAL 陷阱（2026-11-22 演练实测踩中）**：SQLite 在 WAL 模式下，最近写入可能仍在
     `<库>-wal` 文件里、主库文件停留在上一个 checkpoint 的状态——直接 `cp` 主库文件得到的
     "备份"是**陈旧快照**。本次演练第一轮回退即因此拿到演练前时代的库（旧世界写入还躺在
     WAL 里，看似回退成功实则是旧数据）。做文件级备份点前必须先
     `PRAGMA wal_checkpoint(TRUNCATE)`（sqlite3 或 node:sqlite 均可执行），或改用
     SQLite backup API / `VACUUM INTO '<备份文件>'`。
   - 正式流程**不受影响**：`wrangler d1 export` 是服务端逻辑导出、time-travel 是平台侧
     恢复，都不经过裸文件拷贝；本陷阱只存在于本节的手工副本配方与任何"直接拷 db 文件"
     的本地操作。回退验证必须按第 2 步行数逐项核对，不能凭"库能打开"就认定回退成功。
9. **收尾**：`npm test` 全量 + `npx tsc --noEmit`（只碰本仓库，不碰任何远端库）。

演练记录（每次预演填一行，留档）：

| 日期 | 副本来源 | 对账结果 | 切换验证 | 回退验证 | 并发冒烟 | 执行人 |
|---|---|---|---|---|---|---|
| | | | | | | |

---

## 3. 正式切换流程（另行安排；执行时逐节签核）

顺序总纲：**先迁移装载（库就绪），再切应用（新 Worker 上线）**。理由：新 Worker 的
`/api/daily/open` 依赖新表与教材数据，库未就绪就部署会 500；旧 Worker 不读新表，
迁移装载对它透明。

### 3.1 备份与恢复验证

```sh
mkdir -p backups
npx wrangler d1 export <生产库名> --remote --output backups/pre-cutover-<时间戳>.sql
```

- [ ] `npx wrangler d1 list` 核对目标库后才执行；
- [ ] 导出文件非空、含 `CREATE TABLE` 与 `users` 两条 INSERT；
- [ ] **恢复验证**（备份没验证过 = 没有备份）：把 `<备份文件>` 回放进一次性验证库
  （本地 `sqlite3 /tmp/opencode/verify-<时间戳>.db < <备份文件>` 最简，零远端副作用），
  跑第 6 节对账 SQL，确认 `users=2`、旧进度行数与线上抽查一致；
- [ ] 备份文件移入留档目录（含日期命名），不留在工作区根目录。

### 3.2 旧版本与备份配对

回退 = **旧代码 + 旧库备份**成对使用，任一缺失都不构成可回退点。

- [ ] `npx wrangler deployments list` 记下 `<旧部署版本>`（或当前 commit 哈希）；
- [ ] 填配对表并留档：

| 旧 Worker 版本/commit | 配对备份文件 | 恢复验证结果 | 确认人 |
|---|---|---|---|
| | pre-cutover-<时间戳>.sql | | |

### 3.3 停写窗口

- **时机**：低峰（建议上学时段）或维护模式（前端挂维护页/停服）。
- **窗口**：覆盖"迁移 → 装载 → 对账 → 部署新 Worker → 冒烟"全程，建议 ≤30 分钟。
- **为什么必须停写**（如实说明，不粉饰）：
  - 0003 的 DELETE 清零与教材装载**不是单条原子语句**；窗口内有旧 Worker 写入的话，
    要么写进旧表被"清零"语义吞掉，要么让对账数字对不上；
  - 清零后、新 Worker 部署前，旧 Worker 收到的作答会写进旧表——新功能读不到（只读新表），
    回退场景下这些写入会被备份恢复覆盖而**丢失**；
  - d1 migrations apply / execute --file 中途失败会留下部分应用状态——这正是 3.1 先备份、
    3.4 逐条签核的原因；`d1_migrations` 已应用的版本不会重跑。

### 3.4 先迁移 + 装载

```sh
# ① 迁移（0001/0002 已应用会自动跳过；0003 建新表 + 一次性清零）
npx wrangler d1 migrations apply <生产库名> --remote

# ② 装载教材（幂等，可重复执行对齐）
node scripts/build-curriculum-sql.mjs > /tmp/opencode/curriculum-<时间戳>.sql
npx wrangler d1 execute <生产库名> --remote --file /tmp/opencode/curriculum-<时间戳>.sql
```

- [ ] 每条命令前重复第 0 节目标库确认；
- [ ] `npx wrangler d1 migrations list <生产库名> --remote` 确认 0003 状态。

### 3.5 对账（装载后、部署前）

在 `<生产库名>` 上执行第 6 节对账 SQL：

- [ ] curriculum_units = **52**、curriculum_senses = **722**、curriculum_unit_senses = **903**；
- [ ] `pool_units` 为空（开放单元由管理页在切换后逐步加入）；
- [ ] `user_word_state/user_unit_word_seen/wrong_answer_events/user_stats` 均为 0 行；
- [ ] `users` 仍为 2 行（孩子账号保留）。

### 3.6 再切应用

- [ ] `npx wrangler deploy`（部署新 Worker）；
- [ ] 冒烟（只读/低风险）：`GET /api/health` 200；管理页课程列表可见 52 个单元；
  两个孩子首页星星 0、连击 0、错词 0、共享池空；空池打开每日清单返回
  `items=[]` 且 `emptyReason=no_open_units`；
- [ ] 解除停写/维护模式。

### 3.7 切换后验证（当天内完成）

- [ ] 管理页加入首个开放单元 → 次日两人清单全为新词（无到期卡）；
- [ ] 首次作答走通：哥哥错进订正、弟弟对得星星；
- [ ] 错词本、进度页数据一致（复用 `test/cutover.test.ts` 的断言口径）。

---

## 4. 失败回退

判据（任一即回退）：迁移/装载报错；对账数字不符；新 Worker 冒烟失败且 15 分钟内无法定位。

```sh
# ① 回滚代码到配对的旧版本
npx wrangler rollback            # 回到 <旧部署版本>（或重新部署旧 commit）

# ② 恢复数据（首选 D1 时间点回档，30 天窗口）
npx wrangler d1 time-travel restore <生产库名> --timestamp="<切换前时刻，ISO 8601>"
```

- [ ] 回档/恢复后重跑第 6 节对账 SQL：`users=2`、旧进度行数与 3.1 验证值一致；
- [ ] 旧 Worker 冒烟（首页/复习可写）通过后再解除停写；
- [ ] **注意**：回档会丢弃回档点之后的一切写入（含切换后新进度）——回退决策宜早不宜迟；
- [ ] **迁移账本语义**：回档会连同 `d1_migrations` 一起回到过去，0003 重新变为"未应用"，
  可安全重试切换；若只回滚 Worker 而保留数据（未回档），`d1_migrations` 仍记录 0003
  已应用——此时重试**不得**手工重放清零段，须先由主代理/运维核对再定。
- [ ] 复盘：把失败现象、定位、回退耗时填进 2 节演练记录。

---

## 5. 切换后新记录导出保留

切换产生的新进度（user_cards / daily_lists / daily_items / answer_events / user_stats）
从此只存在于新库状态中；一旦将来需要回到"切换后某时刻"，只能靠它们自己的备份点。

- [ ] 切换验证通过、孩子开始产生新进度后（当晚或次日）：  
  `npx wrangler d1 export <生产库名> --remote --output backups/post-cutover-<时间戳>.sql`
- [ ] 回放验证同 3.1（一次性验证库 + 对账 SQL），与 pre-cutover 备份同目录留档；
- [ ] 之后并入既有备份节奏（建议每周导出一次；有 time-travel 兜底但仍以导出文件为最终留档）。

---

## 6. 附：对账 SQL 速查

```sql
-- 教材数量（期望 52 / 722 / 903）
SELECT (SELECT COUNT(*) FROM curriculum_units)        AS units,
       (SELECT COUNT(*) FROM curriculum_senses)       AS senses,
       (SELECT COUNT(*) FROM curriculum_unit_senses)  AS links;

-- 换库零状态（期望全 0；users 期望 2）
SELECT (SELECT COUNT(*) FROM user_word_state)      AS old_state,
       (SELECT COUNT(*) FROM user_unit_word_seen)  AS old_seen,
       (SELECT COUNT(*) FROM wrong_answer_events)  AS old_wrong,
       (SELECT COUNT(*) FROM user_stats)           AS old_stats,
       (SELECT COUNT(*) FROM pool_units)           AS pool,
       (SELECT COUNT(*) FROM users)                AS users;

-- 迁移账本
SELECT * FROM d1_migrations ORDER BY id;
```

自动化等价物：`npm test -- test/cutover.test.ts`（端到端：清零→装载→对账→首学→
再导入幂等→次日复习）、`npm test -- test/curriculum-migration.test.ts`（表级语义）、
`node scripts/build-curriculum.mjs --check`（books.json 与词表源一致）。
**这些命令只对隔离测试库运行，任何情况下不得指向生产库。**
