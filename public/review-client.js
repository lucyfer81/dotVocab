// ---------- 乐观上报：答案判定不等人 ----------
// 提交瞬间 UI 已本地判定并给出反馈；/review 与 /cover 在后台并行发出，
// 一滴不阻塞学习流程。失败只做非阻塞提示（onError）：进度没存上，
// 下次这个单词还会出现，对孩子无损——绝不让网络问题打断学习节奏。

export function recordAnswer(opts) {
  const { post, userId, wordId, correct, unitId, onError } = opts;
  const requests = [
    post("/review", { user_id: userId, word_id: wordId, correct }),
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
    if (failed && onError) onError();
  });
}
