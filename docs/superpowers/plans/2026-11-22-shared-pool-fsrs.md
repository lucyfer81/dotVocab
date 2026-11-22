# 共享学习池与每日 FSRS 清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 家长一次开放若干教材单元，哥哥、弟弟分别获得可续练的每日清单。

**Architecture:** 离线生成可核对的教材清单，通过新增 D1 表连接教材、共享池、每日任务和个人卡片。服务端负责选词、判定首次作答及更新 FSRS；浏览器只展示已保存的清单和提交练习事件。

**Tech Stack:** TypeScript、Hono、Cloudflare Workers/D1、ts-fsrs、原生浏览器 JavaScript、Vitest；离线教材转换用 Node.js。

**Spec:** `docs/superpowers/specs/2026-11-22-shared-pool-fsrs-design.md`

## Global Constraints

- 五册为一上、一下、二上、二下、三上；包含非加粗词和短语。只导入审核后的词表。
- 共享池初始为空；每人每天 10、15 或 20 个不同词，默认 10；以上海自然日为界。
- 清单一旦生成即固定；只由每日首次独立作答或首次看答案产生 Good / Again；订正及自主加练不再调度。
- 换库时保留账号，一次性清零卡片、到期日、覆盖记录、错词、星星和连续学习天数；不做旧词匹配或历史迁移。

## Review Focus

1. 新教材同形异义不能因词形相同而误合并（任务 1、2）。
2. 多选中混入无效单元不能部分入池（任务 3）。
3. 两台设备首次打开、甚至拿到空清单，也只能生成一份（任务 5）。
4. 两台设备给出相反答案，应只认先成功持久化的首次作答（任务 6）。
5. 昨晚打开的页面次日迟交，不得覆盖今天的进度（任务 6、7）。

## 文件与任务顺序

1–2 负责教材与兼容迁移；3、4 分别提供管理接口及调度函数；5–6 组成每日任务后端；7 接通已有页面；8 演练切换。每项仅提交本项列出的文件，在普通开发分支执行。

### 1. 生成可审阅的五册教材数据

**文件：** 新增 `scripts/build-curriculum.mjs`、`data/curriculum/{books,overrides}.json`、`test/curriculum.test.ts`。接口：`buildCurriculum(dir, overrides)` 返回 `{books,issues}`；每条含稳定 `senseKey`、展示词、释义、`accepted[]`、册/单元/行序。

- [ ] 写测试：`expect(hello.accepted).toEqual(['hello','hi'])`；验证短语、非粗体、同词异义、重复行和未裁决条目的报告。
- [ ] 运行 `npm test -- test/curriculum.test.ts`，确认缺少转换器导致失败。
- [ ] 按五个指定文件名读取 Markdown 表；按人工裁决拆分或合并词义。提供 `--preview` 输出逐册逐单元计数、重复与疑项，未裁决时禁止生成正式数据；比对五份原表后提交生成物，使部署不依赖 vault。
- [ ] 重跑同一测试须通过；对真实目录连续生成两次，输出一致、未决数为 0。
- [ ] 提交 `feat: 生成审核后的五册教材清单`。

### 2. 新学习存储与一次性重置

**文件：** 新增 `migrations/0003_curriculum_daily.sql`、`scripts/build-curriculum-sql.mjs`、`test/curriculum-migration.test.ts`；更新 `test/schema.ts`。输入 `books.json`；输出按独立 `sense_id` 装载教材的幂等 SQL。清零只放入由 D1 记录执行版本的一次性切换迁移，不放在导入器或应用启动逻辑中。

- [ ] 在含两个账号及旧进度的库上测试：迁移后账号 ID 不变，旧个人状态、错拼及覆盖为空、星星和连续天数为零；换库后产生的新记录在重复导入时原样保留。
- [ ] 运行 `npm test -- test/curriculum-migration.test.ts`，确认新表缺失而失败。
- [ ] 新增教材单元、词义、单元词序、共享池、个人配额、个人卡片、每日清单及条目、作答事件表。唯一键分别约束池单元、个人词义、个人日期、清单词义和事件标识。一次性迁移清空 `user_word_state`、`user_unit_word_seen`、`wrong_answer_events`、`user_stats`，保留 `users`。生成器以稳定键 upsert，无需关联旧词。
- [ ] 重跑上述测试，核对账号、清零结果、空池以及重复导入不影响新进度。
- [ ] 提交 `feat: 新增教材与个人学习状态存储`。

### 3. 管理共享单元和个人配额

**文件：** `src/admin.ts`、`public/admin.{js,html}`、新增 `test/pool-admin.test.ts`。接口：受现有 adminAuth 保护的 `GET /api/admin/curriculum`（册、单元、已开放标志、两人配额），`POST /api/admin/pool` 接受 `{unitIds:number[]}`，`PUT /api/admin/quota` 接受 `{userId,limit}`。

- [ ] 测试无凭据被拒；`[valid,missing]` 返回 400 且池为空；重复添加结果相同；配额 12 被拒、更改哥哥不影响弟弟。
- [ ] 运行 `npm test -- test/pool-admin.test.ts`，确认接口不存在。
- [ ] 校验整批后原子加入；页面按册多选、显示已加入单元和独立配额，使用新教材目录。
- [ ] 重跑该测试通过，并在管理页检查一次选择多个单元的结果。
- [ ] 提交 `feat: 管理共享单元和个人每日配额`。

### 4. 封装真实 FSRS

**文件：** `package{,-lock}.json`、新增 `src/fsrs.ts`、`test/fsrs.test.ts`。输出 `advanceCard(previous: string|null, rating: 'Good'|'Again', nowMs: number): {state:string; dueMs:number}`，状态按版本序列化，反序列化时还原日期。

- [ ] 固定时间测试首次 Good / Again 与所锁库默认调度结果相等；序列化往返后复习与连续调用结果一致。
- [ ] 运行 `npm test -- test/fsrs.test.ts`，确认适配器不存在。
- [ ] 安装并锁定兼容 Workers 的 `ts-fsrs`，用默认参数、显式时间和库的空卡片接口；不要从旧 `reps` 伪造卡片。
- [ ] 重跑该测试及 `npx tsc --noEmit`，均须通过。
- [ ] 提交 `feat: 封装 FSRS 卡片调度`。

### 5. 生成并固定每日清单

**文件：** 新增 `src/daily-list.ts`、`test/daily-list.test.ts`；修改 `src/kid.ts`。接口：`POST /api/daily/open {userId}` → `{day,limit,items:[{id,senseId,term,meaning,status}],emptyReason}`；状态 `pending|correction|done`。

- [ ] 测试 6 到期＋4 新、12 到期取最早 10、仅未来卡不补、跨单元重复只取一次；两人不同历史得到不同清单。并发打开得到相同条目 ID；空池打开后当天加单元仍为空，上海次日才变化。
- [ ] 运行 `npm test -- test/daily-list.test.ts`，确认缺少路由。
- [ ] D1 原子批次创建日期头和有序条目；只有成功创建该头的生成令牌可插入条目，持久化零条目。用上海日末界定当日到期，按到期时间、稳定键排列，再按册、单元、行序补无历史的新词；只读取当前孩子的状态。首页以已生成清单为准，预览不得提前锁定当天清单。
- [ ] 重跑上述测试通过，包含配额中途更改、昨日未作答的新词仍可选。
- [ ] 提交 `feat: 固定每个孩子的每日清单`。

### 6. 首次作答、订正与奖励一次生效

**文件：** 新增 `src/daily-answer.ts`、`test/daily-answer.test.ts`；修改 `src/kid.ts`。接口：`POST /api/daily/answer {userId,itemId,eventId,action:'spell'|'reveal',answer?:string}` 返回权威条目状态。消费任务 4 的 `advanceCard`。

- [ ] 测试首次正确只奖一次；错→订正正确只留一个 Again，只记一次首次错误，不为订正加星；同事件重发返回原结果，不同事件并发只产生一次评级；其他孩子不能提交；过上海午夜迟交返回 409，无副作用。
- [ ] 运行 `npm test -- test/daily-answer.test.ts`，确认缺少路由。
- [ ] 服务端按审核过的可接受答案判定；检查归属和日期。批次内用条目状态条件抢占首次作答、写事件、卡片前后状态、错拼、星星及连续学习统计；每项副作用由获胜事件守卫，不能只依靠客户端 UUID。订正仅推进条目；错误订正保留待订正状态。独立加练写练习日志，兼容旧 `/review` 客户端时也禁止改写 FSRS。
- [ ] 重跑该测试和 `npm test -- test/api.test.ts`，将确实废止的旧调度断言换成新契约，保留权限及历史回归。
- [ ] 提交 `feat: 原子记录每日回忆与订正`。

### 7. 接通孩子页面及历史视图

**文件：** `public/app.js`、`public/review-client.js`、`public/index.html`、`src/{kid,admin}.ts`、`test/{review-client,api}.test.ts`。消费任务 3、5、6 的接口；单元练习改读活动教材，错词本只展示换库后的记录。

- [ ] 测试断线重试沿用同一事件 ID，恢复时跳过 done、把 correction 放在其他待练词之后，只有一个错词时可立即订正；409 提示重新打开今日清单。验证加练不完成每日条目、不改 due。
- [ ] 运行 `npm test -- test/review-client.test.ts test/api.test.ts`，确认新增用例失败。
- [ ] 替换每日入口的旧到期队列、先展示答案及客户端自评分支；先独立拼写或主动揭示。进度按不同条目计数。首页区分未开放单元和暂无到期词；后台进度/重置覆盖新状态，沿用既有用户范围，不误清另一个孩子或共享池。
- [ ] 重跑上述测试；两浏览器手验同日续练、切换孩子、错词本和管理页数据一致。
- [ ] 提交 `feat: 接入独立每日任务与错词订正`。

### 8. 换库演练与切换

**文件：** 新增 `docs/curriculum-cutover.md`、`test/cutover.test.ts`。产出可重复的预演、对账和回退步骤。

- [ ] 写端到端夹具：带旧进度的库→一次性切换→验证两人从零开始→加入同一单元→哥哥错、弟弟对→再次导入→次日打开；断言新进度不被抹掉、兄弟卡片不同、两次导入无重复。
- [ ] 运行 `npm test -- test/cutover.test.ts` 验证夹具确实能检出未装载教材的错误，然后接通完整迁移/装载流程。
- [ ] 记录正式库备份与恢复验证、旧版本与备份配对、停写窗口、预演数量核对、先迁移装载再切应用、失败回退及切换后产生的新记录如何导出保留。实施验收用隔离 D1 副本演练，不把测试命令指向生产库。
- [ ] 运行 `npm test`、`npx tsc --noEmit`；在副本完成切换及回退，验证切换后两人从零开始、空池无任务，加池后首份清单全为新词；回退后恢复切换前数据。
- [ ] 提交 `test: 验证教材切换与回退流程`。
