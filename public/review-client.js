// ---------- 上报客户端：两条互不越界的通道 ----------
// 1) recordDailyAnswer —— 每日任务：POST /api/daily/answer（服务端判定、FSRS、星星）。
//    eventId 规范 `${userId}:${uuid}`：event_id 是全局主键，裸 UUID 在撞库 + 跨用户
//    碰撞时会被服务端守卫拒绝（applied=false），带用户前缀从根上避免。
//    断线重试沿用同一 eventId（服务端按 eventId 幂等回放，同一作答重发不换 ID、
//    不重复计分）；409 = 清单已过上海午夜（onConflict 一次，本地不再重试该事件）；
//    响应里的 item.status 是权威状态，上层必须直接采纳（迟到设备可能拿到
//    stage=correction，不得以本地认知覆盖）。
// 2) recordPracticeAnswer —— 自主加练（单元练习/错词本）：POST /api/review sense 路径。
//    不调 /daily/answer、不写 user_cards（不改 FSRS）、不完成每日条目；
//    同一 eventId 稳定重试；失败只做 onError 非阻塞提示，绝不打断练习节奏。
// scheduleDailyItems —— 会话队列调度纯函数（恢复会话与中途调度共用同一规则）。

// UUID 生成三层回退（审阅 Important I-1）：项目设备画像含旧 iPad（Safari < 15.4，
// 无 crypto.randomUUID）且非安全上下文下 crypto 本身可能缺失——每日主流程的
// eventId 生成不允许抛错挂起 UI。
//   1) crypto.randomUUID()（现代浏览器 + 安全上下文）
//   2) crypto.getRandomValues(new Uint8Array(16)) 拼 v4 形式
//   3) Math.random 兜底拼 v4 形式（随机性最弱；每人每日事件量 ≤20，同用户碰撞
//      可忽略，服务端另有归属校验与跨用户守卫兜底）
// 三层输出统一为 36 位 v4 形状（8-4-4-4-12 含连字符），eventId 总长 ≤100。
function randomUuid() {
  // Safari < 12.2 无 globalThis：直接访问抛 ReferenceError（不是 undefined）——
  // typeof 守卫先行，globalThis 或 crypto 缺失时直接落向下层回退链（审阅 M-d）。
  const c = typeof globalThis === "undefined" ? undefined : globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID();
    } catch {
      // 环境异常：落向下层回退
    }
  }
  if (c && typeof c.getRandomValues === "function") {
    try {
      const bytes = c.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
      let hex = "";
      for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, "0");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      // 环境异常：落向下层回退
    }
  }
  const hexBlock = (n) => {
    let s = "";
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  };
  const variant = "89ab"[Math.floor(Math.random() * 4)];
  return `${hexBlock(8)}-${hexBlock(4)}-4${hexBlock(3)}-${variant}${hexBlock(3)}-${hexBlock(12)}`;
}

export function makeEventId(userId) {
  return `${userId}:${randomUuid()}`;
}

// 恢复/调度规则：
//   - 跳过 done（已完成的条目恢复时不再出现）；
//   - correction 排在所有其他待练词之后（错词隔开其他词再订正，组内保持服务端顺序）；
//   - 只剩 correction（含仅一个错词）时立即进入订正，不人为拖延。
export function scheduleDailyItems(items) {
  const pending = [];
  const corrections = [];
  for (const it of items ?? []) {
    if (it.status === "done") continue;
    (it.status === "correction" ? corrections : pending).push(it);
  }
  return pending.concat(corrections);
}

// post: (path, body) => Promise；失败时 reject 带 .status（HTTP 状态码，网络断线则无）。
// opts: { post, userId, itemId, action: 'spell'|'reveal', answer?, eventId?,
//         onResult(响应), onError(err, eventId), onConflict(err) }
// 返回权威响应（成功/幂等回放）或 null（最终失败/409）。
export async function recordDailyAnswer(opts) {
  const { post, userId, itemId, action, answer, onResult, onError, onConflict } = opts;
  const eventId = opts.eventId ?? makeEventId(userId);
  const send = () => post("/daily/answer", {
    userId,
    itemId,
    eventId,
    action,
    ...(action === "spell" ? { answer } : {}), // reveal 不携带 answer（服务端忽略）
  });
  const isConflict = (e) => e && e.status === 409;
  // 首发一次；仅网络类失败（无 HTTP 状态）用同一 eventId 重试一次；
  // 409 终止重试并上报 onConflict（上层提示重新打开今日清单）；其余 HTTP 错误直接上报。
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await send();
    } catch (e) {
      if (isConflict(e)) { if (onConflict) onConflict(e); return null; }
      if ((e && e.status != null) || attempt === 1) { if (onError) onError(e, eventId); return null; }
      continue; // 网络断线：同 eventId 重发
    }
    if (onResult) onResult(res);
    return res;
  }
  return null; // 不可达（循环内必然返回）
}

// One ordered outbox per learner. Each event has its own storage key so two
// tabs cannot overwrite each other's pending submissions.
export function createDailySync({ userId, post, storage, locks, retryMs = 8000 }) {
  const prefix = `dotvocab:daily-answer:${userId}:`;
  const pending = new Map();
  const listeners = new Set();
  let running = false;
  let retryTimer;
  let lastOrder = 0;

  function notify(event, result, rejected) {
    for (const listener of listeners) listener(event, result, rejected);
  }

  function restore() {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const event = JSON.parse(storage.getItem(key));
        if (event?.eventId && !pending.has(event.eventId)) {
          pending.set(event.eventId, { ...event, durable: true });
          lastOrder = Math.max(lastOrder, event.order);
        }
      }
    } catch {} // Storage can be unavailable in private browsing.
  }

  async function drain() {
    restore();
    while (pending.size) {
      const event = [...pending.values()].sort((a, b) => a.order - b.order)[0];
      let rejected;
      const result = await recordDailyAnswer({
        ...event, userId, post,
        onConflict: () => { rejected = "stale_day"; },
        onError: (error) => {
          if ([400, 404, 422].includes(error.status)) rejected = "rejected";
        },
      });
      if (!result && !rejected) return;
      pending.delete(event.eventId);
      try { storage.removeItem(prefix + event.eventId); } catch {}
      notify(event, result, rejected);
    }
  }

  async function flush() {
    if (running) return;
    clearTimeout(retryTimer);
    running = true;
    try {
      if (locks) await locks.request(prefix, drain);
      else await drain();
    } finally {
      running = false;
      if (pending.size) retryTimer = setTimeout(flush, retryMs);
    }
  }

  restore();
  return {
    enqueue({ day, itemId, action, answer }) {
      const eventId = makeEventId(userId);
      const order = lastOrder = Math.max(Date.now(), lastOrder + 1);
      const event = { day, itemId, action, answer, eventId, order };
      let durable = false;
      try {
        storage.setItem(prefix + eventId, JSON.stringify(event));
        durable = true;
      } catch {}
      pending.set(eventId, { ...event, durable });
      notify();
      void flush();
      return eventId;
    },
    entries: () => [...pending.values()].sort((a, b) => a.order - b.order),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush,
  };
}

// opts: { post, userId, senseId, correct, source: 'unit'|'mistake', answer?, eventId?,
//         onResult(响应), onError(err, eventId) }
// 答对 answer 记 null；答错携带原始拼写供练习日志留痕。返回响应或 null。
export async function recordPracticeAnswer(opts) {
  const { post, userId, senseId, correct, source, answer, onResult, onError } = opts;
  const eventId = opts.eventId ?? makeEventId(userId);
  const send = () => post("/review", {
    userId,
    senseId,
    eventId,
    correct,
    source,
    answer: correct ? null : (answer ?? null),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await send();
    } catch (e) {
      if (attempt === 1) { if (onError) onError(e, eventId); return null; }
      continue; // 同 eventId 重发一次（服务端幂等回放，不重复计分）
    }
    if (onResult) onResult(res);
    return res;
  }
  return null;
}
