# 家长后台：手动重置背单词进度

- 日期：2026-07-31
- 状态：待评审
- 范围：家长后台新增「重置进度」面板（后端 1 个端点 + 前端 1 块 UI），不动孩子端
- 关联：`docs/superpowers/specs/2026-07-20-vocab-app-design.md`（数据模型来源）

## 背景

家长后台（`/admin.html`）目前只能「新建单元 / 导入单词 / 编辑词库 / 看进度」，没有任何重置进度入口。当课本内容改版、重新导入或调整单元结构后（见 PDF 导入流水线，prod 现为「三年级上(沪教新版)」10 单元/165 词），或单纯想让孩子把某单元/某书重练一遍时，无法把「单元覆盖」记录清掉重来。

进度数据存在三层（已核对 `migrations/0001_init.sql` + `src/kid.ts`）：

1. **单元覆盖** `user_unit_word_seen(user_id, unit_id, word_id, first_seen_at)` —— 每个单元独立，决定单词在该单元是否算「已学过」；`/api/session/unit` 只返回 `seen.word_id IS NULL` 的词（即未覆盖的当新词推送）。
2. **全局掌握度** `user_word_state(user_id, word_id, reps, interval_days, due_at, lapses, last_reviewed_at)` —— 跨单元的 SRS；`reps >= MASTERY_REPS(=3)` 计入「已掌握」，并驱动复习排期。
3. **星星 / 连击** `user_stats(user_id, stars, streak_days, last_play_date)` —— 奖励数据。

## 目标与非目标

目标：
- 家长可在后台按 **单元 / 书 / 全局** 三种粒度，对 **某个孩子 或 两个孩子** 重置背单词进度。
- 重置让相关单词在对应单元重新变为「未学过」、重新出现，可供重练。

非目标：
- **不重置**全局掌握度 `user_word_state`（已掌握数、复习排期保持不变）。
- **不重置**星星 / 连击 `user_stats`。
- 不改孩子端任何界面 / 路由。
- 不做两步「预览 → 确认」往返；一个 `confirm()` 弹窗足够。
- 不加书名 / 单元下拉的新查询端点（前端从已有 `GET /api/admin/units` 聚合）。

## 关键决策（brainstorm 结论）

| 维度 | 决策 |
|---|---|
| 重置深度 | **只清单元覆盖** `user_unit_word_seen`（软重置）；掌握度与星星保留 |
| 作用对象 | **可选单个孩子或两个孩子**（按孩子隔离） |
| UI 形态 | **统一面板**：范围 + 目标 + 孩子 + 确认 |
| API 形态 | **单一端点** `POST /api/admin/reset-progress`，按 `scope` 拼 WHERE |

### 需知晓的后果

因为只清覆盖、不清掌握度，**「已掌握」数不会随重置变化**。例如全局重置后：所有单元覆盖归 0、全部单词重新出现，但顶部「已掌握 165」照旧。这是「保留徽章、全部重练」模式，不是 bug。若日后觉得显示矛盾，可升级为「覆盖 + 掌握度一起清（星星仍保留）」。

## 数据流

```
家长后台 dashboard
  └─ 重置面板：选 范围/目标/孩子 → 点「重置进度」
       └─ confirm() 二次确认（文案点明范围+目标+孩子+"单词会重新出现，已掌握度和星星保留"）
            └─ POST /api/admin/reset-progress  (header: x-admin-token)
                 └─ adminAuth 校验 token
                 └─ 校验 body → 按 scope 构造参数化 DELETE
                      ├─ unit:   WHERE user_id IN (…)        AND unit_id = ?
                      ├─ book:   WHERE user_id IN (…)        AND unit_id IN (SELECT id FROM units WHERE book=?)
                      └─ global: WHERE user_id IN (…)
                 └─ 读 result.meta.changes → { ok:true, deleted:N }
            └─ 显示「已重置 N 条覆盖记录」→ 刷新 dashboard（/progress + /units）
```

## 后端设计

新增于 `src/admin.ts`（受现有 `admin.use("*", adminAuth)` 保护，无需额外鉴权代码）：

**`POST /api/admin/reset-progress`**

请求体（JSON）：

| 字段 | 类型 | 必填条件 |
|---|---|---|
| `scope` | `"unit" \| "book" \| "global"` | 必填 |
| `unit_id` | number | `scope=unit` 时必填 |
| `book` | string | `scope=book` 时必填 |
| `user_ids` | number[]（非空） | 必填 |

校验（不通过返回 400 + `{ error }`）：
- `scope` ∈ {unit, book, global}
- `scope=unit` → `unit_id` 为正整数
- `scope=book` → `book` 为非空字符串
- `user_ids` 非空数组，元素全为正整数（与现有 kid 端点一致，不做 user 存在性校验；传不存在的 id 只是删 0 行，无害）

执行的 SQL（**仅** `user_unit_word_seen`）：

```sql
-- unit
DELETE FROM user_unit_word_seen WHERE user_id IN (?,?,…) AND unit_id = ?
-- book
DELETE FROM user_unit_word_seen WHERE user_id IN (?,?,…) AND unit_id IN (SELECT id FROM units WHERE book = ?)
-- global
DELETE FROM user_unit_word_seen WHERE user_id IN (?,?,…)
```

**安全**：`user_ids` 的 IN 子句用 `?,?,…` 占位符 + `.bind(...)` 参数化，**绝不字符串拼接**（防 SQL 注入）。`book` / `unit_id` 同样走绑定参数。

响应：`{ ok: true, deleted: <meta.changes> }`。

## 前端设计

`public/admin.js` 的 `dashboard()` 内新增一块「重置进度」面板（建议放在「进度」展示与「新建单元」之间，或 admin-cols 之上独立一行）。字段：

- **范围** `<select>`：单元 / 书 / 全局
- **目标** `<select>`：
  - 范围=单元 → 列出 `units`（`{book} · {unit}`，value=unit id）
  - 范围=书 → 列出从 `units` 去重的 `book`
  - 范围=全局 → 隐藏目标选择
- **孩子** `<select>`：哥哥 / 弟弟 / 两个孩子。选项从 `dashboard()` 已 fetch 的 `/progress` 结果（含每孩子 `id`/`name`）动态生成，外加一项「两个孩子」（提交时展开为全部 user id）；不硬编码 id。
- **「重置进度」按钮**：点击 → `confirm()` 弹窗 → 确认后 `POST` → 显示 `已重置 N 条覆盖记录` → 重新拉取 `/progress`、`/units` 刷新

书名 / 单元列表均来自 `dashboard()` 已 fetch 的 `units`，**无需新端点**。

## 测试设计

加在 `test/api.test.ts`，沿用 `applySchema()` + `SELF.fetch` + `adminToken` 既有模式。用例：

1. **unit 范围**：seed 两单元 + 覆盖记录 + `user_word_state` + `user_stats` → 重置单元 A → A 覆盖清空、B 不动、`user_word_state` 不动、`user_stats` 不动。
2. **book 范围**：seed 两本书各含单元 → 重置书 X → 书 X 所有单元覆盖清空、书 Y 不动。
3. **global 范围**：所有 `user_unit_word_seen` 清空，`user_word_state` / `user_stats` 不动。
4. **单孩子 vs 两孩子**：重置只影响 `user_ids` 内的孩子，另一孩子覆盖保留。
5. **返回计数**：`deleted` 等于实际删除行数。
6. **鉴权**：无 `x-admin-token` → 401。
7. **参数校验**：缺 `scope` / `scope=unit` 无 `unit_id` / `user_ids` 为空 → 400。

## 影响面

- 改动文件：`src/admin.ts`（+1 端点）、`public/admin.js`（+1 面板）、`test/api.test.ts`（+用例）。可选：`public/style.css` 若面板需要微调间距（尽量复用现有 `.stat` / `.big` / `select` 样式）。
- 不改 schema、不改孩子端、不改 SRS 逻辑。
- 现有 32 个测试不受影响（仅新增）。
