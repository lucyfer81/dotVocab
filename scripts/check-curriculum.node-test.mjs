import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BOOK_SPECS } from './build-curriculum.mjs';

test('--check 的退出码反映落盘数据是否匹配', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'curriculum-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const { file } of BOOK_SPECS) {
    writeFileSync(join(dir, file), '| 序号 | 单元 | 单词 | 读音 | 词义 |\n| 1 | Unit 1 | cat | /kæt/ | 猫 |\n');
  }
  const out = join(dir, 'books.json');
  const overrides = join(dir, 'overrides.json');
  writeFileSync(overrides, '{}');
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./build-curriculum.mjs', import.meta.url)),
    '--dir', dir, '--overrides', overrides, '--out', out, ...args], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  writeFileSync(out, '');
  const result = run('--check');
  assert.match(result.stdout, /不一致（需重新生成）/);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /检查未通过/);
});
