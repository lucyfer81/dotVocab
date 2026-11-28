import { escapeHtml } from "./spell-helpers.js";

const dateLabel = (day) => {
  const [, month, date] = day.split("-").map(Number);
  return `${month} 月 ${date} 日`;
};
const percent = ({ correct, total }) => `${Math.round(100 * correct / total)}%`;

function drawTrend(canvas, weeks) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const inset = 10;
  const yAt = rate => height - inset - rate * (height - 2 * inset);
  ctx.strokeStyle = "#dbe4ef";
  for (const rate of [0, 0.5, 1]) {
    ctx.beginPath();
    ctx.moveTo(0, yAt(rate));
    ctx.lineTo(width, yAt(rate));
    ctx.stroke();
  }

  const points = weeks.map((week, i) => week.total
    ? { x: (i + 0.5) * width / weeks.length, y: yAt(week.correct / week.total) }
    : null);
  ctx.strokeStyle = ctx.fillStyle = "#2563eb";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, i) => {
    if (!point) return;
    if (points[i - 1]) ctx.lineTo(point.x, point.y);
    else ctx.moveTo(point.x, point.y);
  });
  ctx.stroke();
  for (const point of points) {
    if (!point) continue;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function renderDashboard(container, data, child) {
  const { today, recentReview, repeatedMistakes, correctionReview, tomorrow, weeks } = data;
  const todayCopy = !today ? "<p>今天还没打开学习任务</p>"
    : today.total === 0 ? "<p>今天没有可安排的词义</p>"
    : `<p><strong>已完成 ${today.done}/${today.total}</strong> · 待订正 ${today.correction} · 未作答 ${today.pending}</p>
       <progress aria-label="今日任务完成进度" value="${today.done}" max="${today.total}"></progress>
       <p>今日安排：复习 ${today.due} 个，新学 ${today.new} 个。</p>`;
  let correctionCopy = "近 30 天没有已完成的订正";
  if (correctionReview.completed) {
    const { completed, total, correct, waiting } = correctionReview;
    correctionCopy = total
      ? `近 30 天订正完成 ${completed} 次，其中 ${total} 次已有下次复习，${correct}/${total} 次一遍答对（${percent(correctionReview)}）。${waiting ? `另有 ${waiting} 次等待下次作答。` : ""}`
      : `近 30 天订正完成 ${completed} 次，等待下次复习验证。`;
  }
  container.innerHTML = `
    <div class="dashboard-grid">
      <article class="progress-card daily-progress"><h3>今日进度</h3>${todayCopy}</article>
      <article class="progress-card"><h3>近 7 天复习表现</h3>
        <p>${recentReview.total
          ? `到期复习时，${recentReview.total} 次里有 ${recentReview.correct} 次一遍答对（${percent(recentReview)}）。`
          : "近 7 天还没有已作答的到期复习"}</p></article>
      <article class="progress-card"><h3>最近反复出错的词</h3>
        ${repeatedMistakes.length ? `<ul class="dashboard-mistakes">${repeatedMistakes.map(word => `
          <li><strong lang="en">${escapeHtml(word.term)}</strong> · ${escapeHtml(word.meaning)}
            <span class="muted">近 30 天有 ${word.errorDays} 天首次未答对</span>
            <span class="muted">最近一次首答：${dateLabel(word.latestDay)}，${word.latestCorrect ? "答对" : "未答对"}</span>
          </li>`).join("")}</ul>` : "<p>近 30 天没有在两天或以上首次未答对的词义</p>"}
      </article>
    </div>
    <div class="dashboard-grid">
      <article class="progress-card"><h3>订正后的下次复习</h3><p>${correctionCopy}</p></article>
      <article class="progress-card"><h3>明日复习量</h3>
        <p>${tomorrow.due
          ? `按当前进度，明天预计有 ${tomorrow.due} 个词义需要复习。每日上限 ${tomorrow.quota} 个，最多安排 ${tomorrow.scheduled} 个复习词义。`
          : "按当前进度，明天暂无到期复习"}</p>
        <p class="muted">明日清单以实际打开时为准。</p></article>
    </div>
    <article class="progress-card">
      <h3>按周趋势</h3>
      <p class="muted">最近 8 周到期复习的首次答对率</p>
      <div class="dashboard-chart" role="region" aria-label="按周复习趋势" tabindex="0">
        <div class="dashboard-chart-inner">
          <canvas width="800" height="140" aria-hidden="true"></canvas>
          <ol>${weeks.map(week => `<li>
            <time datetime="${week.start}">${dateLabel(week.start)}</time>
            <span>${week.total ? `${week.correct}/${week.total} · ${percent(week)}` : "无复习记录"}</span>
            ${week.current ? '<strong>本周进行中</strong>' : ""}
          </li>`).join("")}</ol>
        </div>
      </div>
    </article>
    <p><a class="link" href="?vocabulary=${encodeURIComponent(child.id)}">查看${escapeHtml(child.name)}的词汇掌握</a></p>`;
  drawTrend(container.querySelector("canvas"), weeks);
}

export function setupParentDashboard(panel, children, api, selectedId) {
  const select = panel.querySelector("#dashboard-child");
  const container = panel.querySelector("#dashboard-stats");
  for (const child of children) select.add(new Option(child.name, child.id));
  if (children.some(child => String(child.id) === selectedId)) select.value = selectedId;
  select.disabled = children.length === 0;

  let latestRequest = 0;
  async function refresh() {
    const request = ++latestRequest;
    const child = children.find(child => String(child.id) === select.value);
    if (!child) {
      container.textContent = "暂无孩子";
      return;
    }
    container.innerHTML = '<p class="muted" role="status">正在加载学习进度…</p>';
    container.setAttribute("aria-busy", "true");
    try {
      const data = await api(`/dashboard/${child.id}`);
      if (request === latestRequest) renderDashboard(container, data, child);
    } catch (error) {
      if (request !== latestRequest) return;
      container.innerHTML = `<p role="alert">学习进度加载失败。${escapeHtml(error.message)}</p>
        <button type="button" class="link">重试</button>`;
      container.querySelector("button").onclick = refresh;
    } finally {
      if (request === latestRequest) container.removeAttribute("aria-busy");
    }
  }
  select.onchange = refresh;
  return refresh;
}
