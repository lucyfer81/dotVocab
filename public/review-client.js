// ---------- 乐观上报：答案判定不等人 ----------
// 提交瞬间 UI 已本地判定并给出反馈；/review 与 /cover 在后台并行发出，
// 一滴不阻塞学习流程。失败只做非阻塞提示（onError）：进度没存上，
// 下次这个单词还会出现，对孩子无损——绝不让网络问题打断学习节奏。
// source/answer 供错题本事件日志使用；onResult 在 /review 结束后回调
// （成功→响应 JSON，含最新 SRS state；失败→null），供会话小结统计毕业数。

export function recordAnswer(opts) {
  const { post, userId, wordId, correct, unitId, source, answer, onError, onResult } = opts;
  const requests = [
    post("/review", {
      user_id: userId, word_id: wordId, correct,
      source: source ?? null,
      answer: correct ? null : (answer ?? null),
    }),
  ];
  // 单元覆盖只在答对时推进：答错的词不算"学会"，下次学新词时还会出现
  if (unitId && correct) {
    requests.push(post("/cover", { user_id: userId, unit_id: unitId, word_id: wordId }));
  }
  let failed = false;
  Promise.allSettled(requests).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") failed = true;
    }
    if (onResult) onResult(results[0].status === "fulfilled" ? results[0].value : null);
    if (failed && onError) onError();
  });
}
