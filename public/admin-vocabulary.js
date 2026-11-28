import { escapeHtml } from "./spell-helpers.js";

const stages = {
  not_started: "未开始",
  learning: "刚开始",
  relearning: "需巩固",
  review: "复习中",
  unknown: "状态待确认",
};

const unitName = unit => unit.unit === 0 ? "Starter" : `Unit ${unit.unit}`;

function vocabularyRow(entry, today) {
  const { term, meaning, stage, dueOn, lastRating, locations } = entry;
  const dueLabel = dueOn && (dueOn < today ? "已逾期" : dueOn === today ? "今日到期" : "");
  return `<li class="vocabulary-word">
    <div class="vocabulary-word-main"><strong lang="en">${escapeHtml(term)}</strong> ${escapeHtml(meaning)}</div>
    <div class="vocabulary-word-meta">
      <span class="vocabulary-stage" data-stage="${stage}">${stages[stage]}</span>
      ${lastRating === "Again" ? '<span class="muted">上次回忆未通过</span>' : ""}
      ${dueOn ? `<span class="muted">下次复习 <time datetime="${dueOn}">${dueOn}</time></span>` : ""}
      ${dueLabel ? `<strong class="vocabulary-due">${dueLabel}</strong>` : ""}
    </div>
    <ul class="vocabulary-locations" aria-label="所属教材和单元">${locations.map(unit => `
      <li>${escapeHtml(unit.bookTitle)} · ${unitName(unit)}${unit.open ? "" : "（未开放）"}</li>`).join("")}
    </ul>
  </li>`;
}

export async function vocabularyPage(api, userId) {
  const page = document.createElement("section");
  page.innerHTML = `<header class="top"><h1>词汇掌握</h1><a class="link" href="?">返回家长后台</a></header>`;
  let data;
  try {
    const id = Number(userId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("孩子编号无效");
    data = await api(`/vocabulary/${id}`);
  } catch (error) {
    if (error.status === 401) throw error;
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = error.message;
    page.append(message);
    return page;
  }

  const { user, today, entries } = data;
  const heading = document.createElement("h2");
  heading.textContent = `${user.avatar} ${user.name}`;
  page.append(heading);

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "共享学习池暂无词义。";
    page.append(empty);
    return page;
  }

  page.insertAdjacentHTML("beforeend", `
    <div class="vocabulary-filters">
      <div><label for="vocab-book">教材</label><select id="vocab-book"><option value="">所有教材</option></select></div>
      <div><label for="vocab-unit">单元</label><select id="vocab-unit"></select></div>
      <div><label for="vocab-search">搜索</label><input id="vocab-search" type="search" placeholder="输入英文或中文释义" /></div>
    </div>
    <div class="vocabulary-stages" role="group" aria-label="按记忆状态筛选"></div>
    <p class="muted" id="vocab-result" role="status"></p>
    <ul class="vocabulary-list" aria-label="共享池词汇"></ul>`);

  const bookSelect = page.querySelector("#vocab-book");
  const unitSelect = page.querySelector("#vocab-unit");
  const search = page.querySelector("#vocab-search");
  const stageGroup = page.querySelector(".vocabulary-stages");
  const result = page.querySelector("#vocab-result");
  const list = page.querySelector(".vocabulary-list");

  const units = new Map();
  for (const entry of entries) {
    for (const unit of entry.locations) units.set(unit.unitId, unit);
  }
  const orderedUnits = [...units.values()].sort((a, b) =>
    a.bookOrder - b.bookOrder || a.book.localeCompare(b.book) || a.unit - b.unit);
  const books = new Map(orderedUnits.map(unit => [unit.book, unit.bookTitle]));
  for (const [book, title] of books) bookSelect.add(new Option(title, book));

  function fillUnits() {
    unitSelect.options.length = 0;
    unitSelect.add(new Option("所有单元", ""));
    for (const unit of orderedUnits) {
      if (bookSelect.value && unit.book !== bookSelect.value) continue;
      const title = bookSelect.value ? unitName(unit) : `${unit.bookTitle} · ${unitName(unit)}`;
      unitSelect.add(new Option(unit.open ? title : `${title}（未开放）`, unit.unitId));
    }
  }

  let active = "all";
  const stageOptions = { all: "全部", ...stages };
  if (!entries.some(entry => entry.stage === "unknown")) delete stageOptions.unknown;
  const stageButtons = Object.entries(stageOptions).map(([key, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.onclick = () => { active = key; draw(); };
    stageGroup.append(button);
    return { key, label, button };
  });

  function draw() {
    const book = bookSelect.value;
    const unitId = Number(unitSelect.value);
    const query = search.value.trim().toLowerCase();
    const matching = entries.filter(entry =>
      (!book && !unitId || entry.locations.some(location =>
        (!book || location.book === book) && (!unitId || location.unitId === unitId))) &&
      (!query || entry.term.toLowerCase().includes(query) || entry.meaning.toLowerCase().includes(query)));
    const counts = { all: matching.length };
    for (const entry of matching) counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
    for (const { key, label, button } of stageButtons) {
      button.textContent = `${label} ${counts[key] ?? 0}`;
      button.setAttribute("aria-pressed", String(key === active));
    }
    const visible = active === "all" ? matching : matching.filter(entry => entry.stage === active);
    result.textContent = visible.length ? `共 ${visible.length} 个词义` : "当前筛选没有词义。";
    list.innerHTML = visible.map(entry => vocabularyRow(entry, today)).join("");
  }

  bookSelect.onchange = () => { fillUnits(); draw(); };
  unitSelect.onchange = draw;
  search.oninput = draw;
  fillUnits();
  draw();
  return page;
}
