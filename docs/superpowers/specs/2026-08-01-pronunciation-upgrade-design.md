# 设计：英语发音升级（浏览器机械音 → Azure 神经语音）

- **日期**: 2026-08-01
- **目标**: 把背单词 App 的单词发音从浏览器自带 `speechSynthesis`（机械音）升级为 Azure Neural TTS（`en-US-JennyNeural`），并在前端兜底保留旧机制，确保按钮永不哑音。

## 1. 背景与问题

当前发音实现在 `public/app.js:24-30`：

```js
function speak(text) {
  if ("speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    speechSynthesis.speak(u);
  }
}
```

问题：语音质量完全取决于操作系统/浏览器内置 TTS 引擎，在大多数设备上音质差、机器味重，不利于小孩跟读模仿。

本设计把它替换为 **Azure Neural TTS** 合成的高质量 mp3，经 **Cloudflare KV** 缓存后供前端 `<audio>` 播放。

## 2. 关键决策

| 决策点 | 取值 | 理由 |
|---|---|---|
| 合成引擎 | **Azure Neural TTS 免费档 (F0)** | 50 万字符/月免费，小词库用不完；官方稳定、有 SLA；标准 REST 接入简单。 |
| 音色 | **`en-US-JennyNeural`（女声）** | 亲切清晰，适合小孩；所有单词统一音色，教学一致。 |
| 缓存 | **Cloudflare KV**，**无 TTL** | 单词发音永不变；读多写少、value 小（mp3 10~50KB，远低于 25MiB 上限）；免费额度充足。 |
| 缓存 key 版本化 | `audio:{lang}:{provider-voice}:{term}` | 换声音/换 Provider 时新建前缀，旧缓存自然作废，避免盲目 TTL 过期重刷。 |
| 架构扩展点 | **Provider 抽象接口** | 以后加 Edge TTS / Google / OpenAI 仅新增一个 adapter，前端零改。 |
| 兜底 | 前端失败回退 `speechSynthesis` | Azure 不可用时（限流/key 失效/网络）仍能发声，按钮永不哑。 |
| 鉴权 | 端点不做用户鉴权 | 绝大多数是 KV 命中，成本极低；靠 term 长度/字符校验 + 词库有限防滥用。 |

**未选方案**：
- Edge TTS（非官方端点，可能随时失效）—— 已知风险，本次不采用。
- 真人词典录音 API（dictionaryapi.dev 等）—— 覆盖不全、无法扩展到句子，被否。
- 纯前端 `getVoices()` 选音 —— 跨设备质量不一致，治标不治本，被否。

## 3. 架构与数据流

```
前端 speak(term)
   │  new Audio(`/api/tts?term=...&lang=en-US`).play()
   ▼
GET /api/tts?term=hello&lang=en-US          （src/tts.ts）
   │
   ├──① 校验 term（非空 / 长度 / 字符）──── 失败 → 400
   │
   ├──② 归一化 term，拼 cache key
   │      audio:en-US:azure-jenny:hello
   │
   ├──③ KV.get(key, "arrayBuffer")
   │      命中 ─────────────────────────────► 200 audio/mpeg
   │      未命中 │
   │             ▼
   │      ④ AzureTtsProvider.synthesize(text, lang)
   │           POST {region}.tts.speech.microsoft.com/cognitiveservices/v1
   │           返回 mp3 ArrayBuffer
   │             │
   │      ⑤ await KV.put(key, mp3)   （无 TTL；await 保证后续命中）
   │             │
   │             └──────────────────────────► 200 audio/mpeg
   │
   └──⑥ 任意合成失败 ──────────────────────► 502
                                                    │
                          前端 <audio>.play().catch │
                                                    ▼
                                       speechSynthesis 兜底（机械音）
```

## 4. 端点契约

`GET /api/tts?term=<word>&lang=en-US`（在 `src/tts.ts` 内，挂载到 `src/index.ts` 的 `/api`）

**请求**：
- `term`（必填）：要朗读的文本。trim 后归一化为小写作为 cache key 一部分。
- `lang`（可选，默认 `en-US`）：BCP-47 语言码，进 cache key 与 SSML `xml:lang`。

**校验**（失败统一返回 `400 {error}`）：
- trim 后非空。
- 长度 ≤ 200 字符。
- 仅允许：字母、数字、空格、`-` `'` `.` `,` `?` `!`（覆盖单词、短语、基本例句）。

**响应**：
- **成功（命中或合成成功）**：`200`，`Content-Type: audio/mpeg`，`Cache-Control: public, max-age=31536000, immutable`（发音永不变，激进长缓存）。
- **合成失败**：`502 {error:"synthesis_failed"}`（上游 Azure 异常，语义为 Bad Gateway），前端据此触发兜底。
- **校验失败**：`400 {error}`。

## 5. KV 缓存层

**绑定**：`Env.AUDIO: KVNamespace`（在 `src/index.ts` 的 `Env` 接口新增）。

**Key 格式**：`audio:{lang}:{provider-voice}:{normalized-term}`
- 例：`audio:en-US:azure-jenny:hello`
- `normalized-term` = `term.trim().toLowerCase()`
- `provider-voice` 段由 Provider 的 `name` 提供（见 §6），换声音时换前缀。

**Value**：原始 mp3 字节，`env.AUDIO.get(key, "arrayBuffer")` 直读。

**写入**：合成成功后 `env.AUDIO.put(key, bytes)`。**不设 `expirationTtl`**（永久）。

**一致性**：KV 最终一致（写入约 60s 全球同步），本场景无影响——首次未命中走一次实时合成即可。

## 6. Provider 抽象 + Azure 实现

### 6.1 接口（`src/tts.ts`）

```ts
export interface TtsProvider {
  /** 进 cache key 的版本段，如 "azure-jenny"。换声音则换此值。 */
  name: string;
  /** 把文本合成成 mp3 字节。失败抛错，由调用方兜底。 */
  synthesize(text: string, lang: string): Promise<ArrayBuffer>;
}
```

注册表按顺序尝试；当前仅注册一个 `AzureTtsProvider`，`name = "azure-jenny"`。

### 6.2 AzureTtsProvider

Azure Cognitive Services TTS REST 接口：

```
POST https://{AZURE_TTS_REGION}.tts.speech.microsoft.com/cognitiveservices/v1
Headers:
  Ocp-Apim-Subscription-Key: {AZURE_TTS_KEY}
  Content-Type: application/ssml+xml
  X-Microsoft-OutputFormat: audio-48khz-192kbitrate-mono-mp3
Body (SSML):
  <speak version='1.0' xml:lang='{lang}'
         xmlns='http://www.w3.org/2001/10/synthesis'>
    <voice name='en-US-JennyNeural'>{escaped-text}</voice>
  </speak>
```

- 返回体即 mp3，`await res.arrayBuffer()` 得到字节。
- 非 2xx → 抛错（含 Azure 返回的状态/原因，便于排障，但**不透传给前端**）。
- SSML 内对 `text` 做 XML 转义（`&` `<` `>` 等），避免注入。
- region 与 key 通过 `Env` 注入（见 §8），不硬编码。

> 注：当前固定 `en-US-JennyNeural`。若以后按 `lang` 选音色，扩展为 `{lang → voiceName}` 映射表即可，`synthesize` 接口不变。

## 7. 前端改动（`public/app.js`）

重写 `speak()`（保持同名同参，所有现有调用点 `speak(w.term)` 零改动）：

```js
function speak(text) {
  const url = `/api/tts?term=${encodeURIComponent(text)}&lang=en-US`;
  const a = new Audio(url);
  a.play().catch(() => {
    // 合成失败 / 网络失败：回退浏览器机械音，保证按钮永不哑
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      speechSynthesis.speak(u);
    }
  });
}
```

调用点不变：`app.js:116`（介绍卡点读）、`app.js:135`/`141`（拼写卡提交后朗读）。

## 8. 配置与密钥

### 8.1 `wrangler.toml`（新增 KV 绑定）

```toml
[[kv_namespaces]]
binding = "AUDIO"
id = "<production-namespace-id>"
preview_id = "<preview-namespace-id>"
```

通过 `wrangler kv namespace create AUDIO`（及 `--preview`）创建，把返回的 id 填入。

### 8.2 `src/index.ts` 的 `Env` 接口扩展

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  AUDIO: KVNamespace;          // 新增
  AZURE_TTS_KEY: string;       // 新增（Worker secret，不入库）
  AZURE_TTS_REGION: string;    // 新增（如 "eastasia"，离国内近）
}
```

挂载路由：`app.route("/api", tts);`（与 `kid` 并列）。

### 8.3 Azure 侧准备（一次性，手动）

1. Azure 门户创建「Speech 服务」资源，选 **F0（免费）** 定价层 + `East Asia` 区域。
2. 在资源「密钥和终结点」页拿 Key + Region。
3. 用 `wrangler secret put AZURE_TTS_KEY` 与 `wrangler secret put AZURE_TTS_REGION` 注入（**不写入仓库**）。

### 8.4 `.dev.vars`

本地 `wrangler dev` 用，加入同名键（同样不入库，`.dev.vars` 已在 `.gitignore`）：
```
AZURE_TTS_KEY=...
AZURE_TTS_REGION=eastasia
```

## 9. 错误处理与兜底链

| 场景 | 后端行为 | 前端行为 |
|---|---|---|
| term 非法 | 400 | `<audio>` 报错 → speechSynthesis 兜底 |
| KV 命中 | 200 mp3 | 正常播放 |
| KV 未命中 + Azure 成功 | 200 mp3 + 异步写 KV | 正常播放 |
| Azure 限流/key 失效/网络 | 502 | `<audio>` 报错 → speechSynthesis 兜底 |
| 同词并发首次请求（thundering herd） | 各自合成一次，KV `put` 幂等 | 用户无感（最多多一次合成） |

并发首次请求在本量级可接受；YAGNI，暂不加锁/单飞（见 §12）。

## 10. 测试策略

基于现有 `vitest` + `@cloudflare/vitest-pool-workers`（可 mock KV/Env）。

**单元测试（`test/tts.test.ts`，用 mock）**：
- 校验：空 term / 超长 / 含非法字符 → 400。
- 缓存命中：mock `AUDIO.get` 返回 bytes → 200，`Content-Type: audio/mpeg`，含 `immutable` 头；且**不调用** Provider。
- 未命中：mock `AUDIO.get` 返回 null + mock Provider 返回 bytes → 200；且验证调用了 `AUDIO.put`，key 含 `azure-jenny` 前缀。
- Provider 抛错 → 502。
- cache key 归一化：`" Hello "` 与 `"hello"` 命中同一 key。

**Provider 单元测试**：
- mock `fetch`：Azure 返回 2xx → 返回 ArrayBuffer，SSML body 含正确 `voice name` 与转义后的 text。
- mock `fetch`：Azure 返回 4xx/5xx → 抛错。
- SSML 注入防护：text 含 `<` `&` 时正确转义。

**Integration（默认跳过，手动/CI 可选）**：
- 真实 Azure key 下合成一个词，断言返回是合法 mp3（魔数头 `ID3`/`FF FB`）。标 `it.skipIf(!process.env.AZURE_TTS_KEY)`。

**前端**：手动验证——拼写卡/介绍卡点读出 Jenny 神经音（非机械音）；断网/关 key 时按钮仍能出机械音。

## 11. 验证步骤

1. `npm run test`（含新增 tts 测试，全绿）。
2. `wrangler kv namespace create AUDIO` → 填 id 进 `wrangler.toml`。
3. `wrangler secret put AZURE_TTS_KEY` / `AZURE_TTS_REGION`。
4. `.dev.vars` 填本地 key。
5. `npm run dev`，浏览器打开 App：
   - 介绍卡点单词 → 听到 Jenny 女声。
   - 拼写卡提交 → 自动朗读为 Jenny 女声。
   - DevTools Network 看 `/api/tts` 首次 200（合成+写 KV）、二次 200（KV 命中，极快）。
   - 故意填错 key 重启 → `/api/tts` 返回 502，前端回退机械音（按钮不哑）。
6. `wrangler kv key list --binding=AUDIO` 抽查缓存条目 key 格式正确。

## 12. 范围之外（YAGNI）

- 不做按 `lang` 自动选音色（当前固定 `en-US-JennyNeural`）。
- 不做并发生成单飞/去重（量级用不上）。
- 不做音频预加载/预热（卡片渲染时预拉 mp3）——首点延迟可接受，后续再说。
- 不做管理后台批量重生成缓存 UI（换声音靠改 Provider name 前缀自然过渡）。
- 不引入任何 npm 依赖（Azure 是标准 REST，`fetch` 即可）。
- 不改词书 schema、不改现有 `kid`/`admin` 路由。
