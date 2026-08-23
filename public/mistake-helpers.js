// ---------- 错题毕业统计（纯函数, 无 DOM, 供 vitest 直接测试） ----------
// 毕业口径: 会话开始时在错题本里(lapses>0 && reps<2, 队列快照即开赛时点)
// 且会话内最后一次成功上报的 state.reps >= 2(连对 2 次毕业)。
// 上报失败的词不在 finalStates 里, 天然不计数(非阻塞降级)。

export function countGraduated(queue, finalStates) {
  let n = 0;
  for (const w of queue) {
    if (w.lapses > 0 && w.reps < 2) {
      const st = finalStates[w.id];
      if (st && st.reps >= 2) n++;
    }
  }
  return n;
}
