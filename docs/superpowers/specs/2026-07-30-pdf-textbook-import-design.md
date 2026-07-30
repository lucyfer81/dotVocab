# 设计：三年级上册 PDF → dotVocab 词书种子导入

- **日期**: 2026-07-30
- **来源**: `materials/三年级上.pdf`（2026 沪教新版三年级英语上册，文本型 PDF，27 页）
- **目标**: 把整本教材的核心词汇按单元解析，生成 SQL 种子文件，替换线上 D1 现有词书。

## 1. 背景与目标

dotVocab 的词书由三张表组成（见 `migrations/0001_init.sql`）：

- `units(book, unit, sort_key)` —— 课本单元，`UNIQUE(book, unit)`
- `words(term, pos, meaning_cn, example_en, example_cn, created_at)` —— 单词，`term` 全局 `UNIQUE` 并去重
- `unit_words(unit_id, word_id)` —— 单元↔单词 多对多（同一单词跨单元复用）

本任务把 PDF 里每个单元的「核心词汇」抽取为 `(term, meaning_cn)` 对，按上述结构生成幂等的 `seed.sql`，并**全量清零**线上现有词书与进度后导入。所有 10 个单元（U1–U10）全部导入。

## 2. 关键约束 / 已验证事实

- **PDF 是文本型**（非扫描），pdfplumber 可直接抽字。**不需要 OCR。**
- **PDF 不含音标(IPA)、不含词性**。因此单词只填 `term` + `meaning_cn`，`pos` / `example_en` / `example_cn` 一律为 `NULL`。符合本项目词书最小格式。
- 每个单元首页结构固定：标题行 `… U<n> 词句汇总` → `一、核心词汇（要求掌握）`（英文行 / 中文释义行交替）→ `二、核心句子（熟读）`。
- **核心句子不导入**：它们无法 1:1 映射到某个单词，属 YAGNI。
- **多词短语对齐靠 x 坐标可靠解决**（见 §4）。已用一次性原型验证：10 单元、168 词，短语如 `play sports` / `be good at` / `fish and chips` / `do the dishes` 全部正确归组。
- **跨单元同词不同义**：`water`（U3 给…浇水 / U4 水）、`study`（U1 学习 / U7 学习;研读）等。需去重与合并策略（见 §5）。
- **全量清零对 App 安全**：所有读 `user_stats` / `user_word_state` 的路径都用 `?? 0` / `LEFT JOIN … COALESCE` / `INSERT … ON CONFLICT`，进度与星星会在孩子首次复习时懒重建。已核对 `src/kid.ts`、`src/srs.ts`、`src/admin.ts`。

## 3. 架构（离线流水线，不依赖 Worker 运行）

```
materials/三年级上.pdf
   │  scripts/import_textbook.py   （pdfplumber，跑在 .venv）
   ▼
   ├─ scripts/out/units.csv          ← 人工复核：单元 + 词数
   ├─ scripts/out/Unit01.csv …       ← 人工复核：term,meaning_cn
   ├─ scripts/out/words.json         ← 单一事实源 + QA 标记
   └─ scripts/out/seed.sql           ← 装载制品（幂等）
        │  wrangler d1 execute dotvocab --local  --file=…   （先本地验证）
        ▼
        wrangler d1 execute dotvocab --remote --file=…       （再上线上）
```

单脚本一次运行产出全部制品。`seed.sql` 用 `INSERT OR IGNORE`，可重复生成 / 重复执行。

## 4. 解析算法

1. **单元检测**：含 `U<n> 词句汇总` 的行 → 开启 `Unit <n>`。
2. **词汇块**：从含 `核心词汇` 的行起，到下一个含 `核心句子` 或 `二、`/`三、` 等编号小节标题的行止。
3. **行配对**：英文行（含拉丁字母、无 CJK）↔ 紧随其后的中文行（含 CJK）。
4. **短语归组（核心）**：
   - 取中文行每个词条的中心 x = `(x0+x1)/2`，相邻中心的中点作为**列边界**，把页面横向切成 N 个列。
   - 把每个英文 token 的中心 x 落到所属列，归入对应中文词条。
   - 同一中文词条下的英文 token 按出现顺序用空格拼接 → `term`。
   - 这样 `play sports`、`be good at`、`tell a story`、`use the computer` 等多词短语自动正确成组。
5. **规范化**：`term` → `lower().strip()`；`meaning_cn` → 去掉尾部 `;` `；` `…` `...` 等残留标点（如 U7 `厨师;` → `厨师`、`太空;` → `太空`）。
6. **已知 QA 项**（脚本在 `out/` 中显式标记，人工复核时重点看）：
   - U9 的 `Chinese New Year` 可能被列切分（原型出现 `chinese 春节;` / `new year 中国新年`），需人工确认。
   - 个别释义因 PDF 内换行而截断（尾部 `;`），由第 5 步清理 + 人工复核兜底。

## 5. 数据决策

| 项 | 取值 |
|---|---|
| `book` | `三年级上(沪教新版)` |
| `unit` | `Unit 1` … `Unit 10` |
| `sort_key` | 单元号（1…10） |
| `pos` / `example_en` / `example_cn` | `NULL` |
| 核心句子 | 不导入 |
| `created_at` | 生成时取一次 `int(time.time())` 写死进 SQL |

**跨单元去重策略**：按规范化 `term` 分组。若同词出现多个不同释义：
- 先去掉「被更长释义包含」的子串（如 `学习` 被 `学习;研读` 包含 → 留后者）。
- 剩余不同释义用 `；` 连接 → 例：`water` → `水；给…浇水`。
- 所有出现「同词不同义」的词条写入 QA 报告，便于人工覆盖。
- 单元↔单词通过 `unit_words` 多对多链接，故共享词在每个单元都出现。

## 6. `seed.sql` 生成（幂等）

```sql
-- units（×10）
INSERT OR IGNORE INTO units (book, unit, sort_key) VALUES ('三年级上(沪教新版)','Unit 1',1);

-- words（×去重后词条数）
INSERT OR IGNORE INTO words (term, pos, meaning_cn, example_en, example_cn, created_at)
  VALUES ('new', NULL, '新的', NULL, NULL, 1753900000000);

-- unit_words（×168）
INSERT OR IGNORE INTO unit_words (unit_id, word_id)
  VALUES (
    (SELECT id FROM units WHERE book='三年级上(沪教新版)' AND unit='Unit 1'),
    (SELECT id FROM words WHERE term='new')
  );
```

- 全部 `INSERT OR IGNORE` → 重复执行不报错、不重复插。
- `unit_id` / `word_id` 不硬编码，全部用子查询按 `book+unit` / `term` 解析，与 autoincrement 解耦。

## 7. 线上重置（全量清零）—— 在导入新词书**之前**

顺序（**先备份**，再删，再导）：

1. **备份线上 DB**（可回滚）：
   `wrangler d1 export dotvocab --remote --output=scripts/out/backup-remote.sql`
2. **清空**（保留两个孩子 `users` 行）：
   ```sql
   DELETE FROM unit_words;
   DELETE FROM user_unit_word_seen;
   DELETE FROM user_word_state;
   DELETE FROM words;
   DELETE FROM units;
   DELETE FROM user_stats;   -- 全量清零：星星/连击也归零，孩子从全新状态开始
   ```
3. 再跑 §6 的 `seed.sql` 导入新词书。

> `users` 表不动（哥哥/弟弟仍在）。`user_stats` 删除后，App 在孩子首次复习时通过 `INSERT … ON CONFLICT` 懒重建，安全。

为减少往返，可把「第 2 步 DELETE」与「§6 INSERT」拼进同一份 `seed.sql`（DELETE 在前、INSERT 在后），一次 `wrangler d1 execute --remote --file=` 执行。但**本地验证用不含 DELETE 的版本**，避免误伤本地数据。

## 8. QA / 错误处理

- 脚本在 `out/` 产出：
  - `units.csv`：每单元词数 + 总数（期望 10 单元、约 168 词）。
  - `Unit01.csv … Unit10.csv`：每单元 `term,meaning_cn`，供人工通读。
  - `words.json`：单一事实源（含 QA 标记：同词不同义、列对齐异常）。
  - `qa-report.txt`：异常清单（对齐失败行、截断释义、冲突词条）。
- 对齐异常处理：若某英文 token 落在所有列之外、或某中文词条无英文 token 对应，记入 QA 报告并跳过该行（不静默吞错）。
- 人工复核门槛：**远程执行前**必须通读 `units.csv` + 抽查 U9、U7（截断释义）。如需修正，编辑 `words.json` 后重跑脚本 `--seed` 步骤重生成 SQL。

## 9. 验证步骤

1. `wrangler d1 execute dotvocab --local --file=scripts/out/seed.sql`（含或不含 DELETE 视情况）。
2. 本地查询核对：
   - `SELECT unit, COUNT(*) FROM units u JOIN unit_words uw ON uw.unit_id=u.id GROUP BY unit ORDER BY u.sort_key;` 词数与 `units.csv` 一致。
   - `SELECT COUNT(*) FROM words;` 等于去重后词条数。
3. 确认无误后再 `--remote`：先 `wrangler d1 export … --remote` 备份，再执行清零 + 导入。
4. 远程抽查：`SELECT book, unit FROM units ORDER BY sort_key;`、词数核对。

## 10. 依赖与文件

- 依赖：`pdfplumber`（已通过 `uv pip install --python .venv/bin/python pdfplumber` 装入 `.venv`，Python 3.12）。
- 新增文件：`scripts/import_textbook.py`；产物目录 `scripts/out/`（gitignore）。
- `.gitignore` 追加：`.venv/`、`scripts/out/`、`materials/`。
- 提交：脚本本身 + 一份示例 `seed.sql`（便于复现）；产物与 PDF 不入库。

## 11. 范围之外（YAGNI）

- 不导入核心句子、不补音标 / 词性 / 例句。
- 不改 App 运行时代码、不改 schema、不加新接口。
- 不做通用「任意 PDF 导入」工具——本脚本只针对这本教材的固定版式。
