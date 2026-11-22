// ---------- 上报客户端：两条互不越界的通道 ----------
// 1) recordDailyAnswer —— 每日任务：POST /api/daily/answer（服务端判定、FSRS、星星）。
//    eventId 规范 `${userId}:${crypto.randomUUID()}`：event_id 是全局主键，裸 UUID
//    在撞库 + 跨用户碰撞时会被服务端守卫拒绝（applied=false），带用户前缀从根上避免。
//    断线重试沿用同一 eventId（服务端按 eventId 幂等回放，同一作答重发不换 ID、
//    不重复计分）；409 = 清单已过上海午夜（onConflict 一次，本地不再重试该事件）；
//    响应里的 item.status 是权威状态，上层必须直接采纳（迟到设备可能拿到
//    stage=correction，不得以本地认知覆盖）。
// 2) recordPracticeAnswer —— 自主加练（单元练习/错词本）：POST /api/review sense 路径。
//    不调 /daily/answer、不写 user_cards（不改 FSRS）、不完成每日条目；
//    同一 eventId 稳定重试；失败只做 onError 非阻塞提示，绝不打断练习节奏。
// scheduleDailyItems —— 会话队列调度纯函数（恢复会话与中途调度共用同一规则）。

export function makeEventId(userId) {
  return `${userId}:${crypto.randomUUID()}`;
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
