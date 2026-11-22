import { showConfirm, showToast } from "./ui.js";

const API = "/api/admin";
let token = localStorage.getItem("dotvocab_admin_token") || "";

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "content-type": "application/json", "x-admin-token": token, ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "请求失败");
  return res.json();
}
function $(html){const t=document.createElement("template");t.innerHTML=html.trim();return t.content.firstElementChild;}
function render(n){const a=document.getElementById("app");a.innerHTML="";a.appendChild(n);}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}

async function boot() {
  if (!token) return loginView();
  try { await dashboard(); } catch (e) { token=""; localStorage.removeItem("dotvocab_admin_token"); loginView(e.message); }
}

function loginView(msg) {
  const card = $(`<section><h1>家长后台</h1>${msg?`<p class="bad">${esc(msg)}</p>`:""}
    <input id="tok" placeholder="管理员口令" />
    <button class="big" id="go">进入</button></section>`);
  card.querySelector("#go").onclick = async () => {
    token = card.querySelector("#tok").value.trim();
    localStorage.setItem("dotvocab_admin_token", token);
    try { await dashboard(); } catch (e) { loginView(e.message); }
  };
  render(card);
}

function poolPanel({books, quotas}) {
  const panel = $(`<section><h2>共享学习池</h2><p class="summary"></p>
    <label>选择教材 <select class="books"></select></label>
    <fieldset><legend>选择要开放的单元（可多选）</legend><div class="units"></div></fieldset>
    <button class="big add">加入共享池</button><p role="status" class="result"></p>
    <h2>个人每日配额</h2><p>从下一份每日清单起生效。</p><div class="quotas"></div></section>`);
  const select = panel.querySelector(".books");
  const add = panel.querySelector(".add");
  const result = panel.querySelector(".result");
  const unitName = u => u.unit === 0 ? "Starter" : `Unit ${u.unit}`;
  books.forEach((b,i) => select.add(new Option(b.title, i)));
  function draw() {
    const open = books.flatMap(b => b.units.filter(u => u.open).map(u => `${b.title} · ${unitName(u)}`));
    panel.querySelector(".summary").textContent = open.length ? `已加入：${open.join("、")}` : "共享池为空，请选择单元加入。";
    panel.querySelector(".units").innerHTML = (books[select.selectedIndex]?.units ?? []).map(u =>
      `<label><input type="checkbox" value="${u.id}" ${u.open ? "checked disabled" : ""}> ${unitName(u)}${u.open ? "（已加入）" : ""}</label>`).join(" ");
    add.disabled = true;
  }
  const selected = () => [...panel.querySelectorAll(".units input:checked:not(:disabled)")];
  panel.querySelector(".units").onchange = () => { add.disabled = !selected().length; };
  select.onchange = draw;
  add.onclick = async () => {
    const book = books[select.selectedIndex];
    const unitIds = selected().map(el => Number(el.value));
    panel.querySelector("fieldset").disabled = select.disabled = add.disabled = true;
    try {
      await api("/pool", {method:"POST",body:JSON.stringify({unitIds})});
      book.units.forEach(u => { if (unitIds.includes(u.id)) u.open = true; });
      draw();
      result.textContent = `已加入 ${unitIds.length} 个单元。`;
    } catch (e) { result.textContent = e.message; add.disabled = false; }
    finally { panel.querySelector("fieldset").disabled = select.disabled = false; }
  };
  draw();
  for (const q of quotas) {
    const row = $(`<label>${esc(q.name)} <select></select></label>`);
    const limit = row.querySelector("select");
    [10,15,20].forEach(n => limit.add(new Option(`每天 ${n} 个`, n)));
    limit.value = q.limit;
    limit.onchange = async () => {
      limit.disabled = true;
      try {
        await api("/quota",{method:"PUT",body:JSON.stringify({userId:q.userId,limit:Number(limit.value)})});
        q.limit = Number(limit.value);
        result.textContent = `${q.name}的每日配额已保存。`;
      } catch (e) { limit.value = q.limit; result.textContent = e.message; }
      finally { limit.disabled = false; }
    };
    panel.querySelector(".quotas").append(row);
  }
  return panel;
}

async function dashboard(flash) {
  const [curriculum, units, words, progress] = await Promise.all([api("/curriculum"), api("/units"), api("/words"), api("/progress")]);
  const wrap = $(`<section>
    <header class="top"><h1>家长后台</h1><button class="link" id="out">退出</button></header>
    <h2>进度</h2><div id="prog"></div>
    <h2>重置进度</h2>
    <div id="reset">
      <select id="r_scope"><option value="unit">按单元</option><option value="book">按课本</option><option value="global">全局</option></select>
      <select id="r_target"></select>
      <select id="r_user"></select>
      <label class="r_deep"><input type="checkbox" id="r_deep" /> 同时重置掌握度与星星/连击</label>
      <button class="big" id="r_go">重置进度</button>
      <pre id="r_result" class="muted"></pre>
    </div>
    <div class="admin-cols">
      <div class="admin-left">
        <h2>新建单元</h2>
        <input id="book" placeholder="课本（如 人教PEP三上）" />
        <input id="unit" placeholder="单元（如 Unit 1）" />
        <input id="sort" placeholder="排序号（数字，可空）" />
        <button class="big" id="addunit">添加单元</button>
        <h2>导入单词到单元</h2>
        <select id="target"></select>
        <textarea id="csv" rows="6" placeholder="每行: 英文,中文释义,词性,例句英,例句中&#10;例: apple,苹果,n&#10;banana,香蕉"></textarea>
        <button class="big" id="imp">导入</button>
        <pre id="impresult" class="muted"></pre>
      </div>
      <div class="admin-right">
        <h2>词库 (<span id="wcount"></span>)</h2>
        <input id="wsearch" placeholder="搜索单词或释义…" />
        <div id="wlist"></div>
      </div>
    </div>
  </section>`);
  wrap.querySelector("header").after(poolPanel(curriculum));
  wrap.querySelector("#out").onclick = () => { token=""; localStorage.removeItem("dotvocab_admin_token"); loginView(); };
  wrap.querySelector("#prog").innerHTML = progress.map(u =>
    `<div class="stat">${esc(u.avatar)} ${esc(u.name)} — ⭐${u.stars} 🔥${u.streak_days} 已掌握${u.mastered}</div>`).join("");
  const sel = wrap.querySelector("#target");
  units.forEach(u => { const o=document.createElement("option"); o.value=u.id; o.textContent=`${u.book} · ${u.unit}`; sel.appendChild(o); });
  wrap.querySelector("#addunit").onclick = async () => {
    const book = wrap.querySelector("#book").value.trim();
    const unit = wrap.querySelector("#unit").value.trim();
    if (!book || !unit) { showToast("课本和单元都要填哦", "bad"); return; }
    const sortRaw = wrap.querySelector("#sort").value.trim();
    const body = { book, unit };
    if (sortRaw !== "") {
      const n = Number(sortRaw);
      if (!Number.isInteger(n)) { showToast("排序号要填整数", "bad"); return; }
      body.sort_key = n; // 留空则整个省略：服务端保留旧排序（B7 契约）
    }
    try {
      await api("/units", { method: "POST", body: JSON.stringify(body) });
      dashboard();
    } catch (e) { showToast(e.message, "bad"); }
  };
  wrap.querySelector("#imp").onclick = async () => {
    try {
      const r = await api("/import",{method:"POST",body:JSON.stringify({unit_id:Number(sel.value),csv:wrap.querySelector("#csv").value})});
      wrap.querySelector("#impresult").textContent = JSON.stringify(r);
      dashboard();
    } catch(e){ wrap.querySelector("#impresult").textContent = e.message; }
  };
  // ---- 重置进度面板 ----
  const rUser = wrap.querySelector("#r_user");
  progress.forEach(u => { const o = document.createElement("option"); o.value = u.id; o.textContent = `${u.avatar} ${u.name}`; rUser.appendChild(o); });
  const rBoth = document.createElement("option"); rBoth.value = "all"; rBoth.textContent = "两个孩子"; rUser.appendChild(rBoth);

  const rScope = wrap.querySelector("#r_scope");
  const rTarget = wrap.querySelector("#r_target");
  function fillResetTarget() {
    rTarget.innerHTML = "";
    if (rScope.value === "global") { rTarget.style.display = "none"; return; }
    rTarget.style.display = "";
    const items = rScope.value === "unit"
      ? units.map(u => ({ value: u.id, label: `${u.book} · ${u.unit}` }))
      : [...new Set(units.map(u => u.book))].map(b => ({ value: b, label: b }));
    items.forEach(it => { const o = document.createElement("option"); o.value = it.value; o.textContent = it.label; rTarget.appendChild(o); });
  }
  rScope.onchange = fillResetTarget;
  fillResetTarget();

  wrap.querySelector("#r_go").onclick = async () => {
    const userVal = rUser.value;
    const user_ids = userVal === "all" ? progress.map(u => u.id) : [Number(userVal)];
    const userLabel = userVal === "all" ? "两个孩子" : (progress.find(u => String(u.id) === userVal)?.name || "");
    const deep = wrap.querySelector("#r_deep").checked;
    const body = { scope: rScope.value, user_ids };
    if (deep) body.deep = true;
    let targetLabel = "全局";
    if (rScope.value === "unit") { body.unit_id = Number(rTarget.value); targetLabel = rTarget.selectedOptions[0]?.textContent || ""; }
    else if (rScope.value === "book") { body.book = rTarget.value; targetLabel = rTarget.value; }
    if (!await showConfirm({
      title: "重置进度",
      message: deep
        ? `确定深度重置「${targetLabel}」的 ${userLabel} 吗？\n单元覆盖记录、范围内单词的掌握度将清除，星星与连击全部归零，单词回到新词状态。`
        : `确定重置「${targetLabel}」的 ${userLabel} 单元覆盖进度吗？\n相关单词会重新出现；已掌握度与星星保留。`,
      okText: "确认重置",
      danger: true,
    })) return;
    try {
      const r = await api("/reset-progress", { method: "POST", body: JSON.stringify(body) });
      dashboard(deep
        ? `已重置 ${r.deleted} 条覆盖记录、${r.state_deleted} 条掌握度记录${r.stats_reset ? "，星星/连击已归零" : ""}`
        : `已重置 ${r.deleted} 条覆盖记录`);
    } catch (e) { wrap.querySelector("#r_result").textContent = e.message; }
  };
  // ---- 词库：搜索 + 行内编辑 + 删除 ----
  const wlist = wrap.querySelector("#wlist");
  const wcount = wrap.querySelector("#wcount");
  const wsearch = wrap.querySelector("#wsearch");
  let allWords = words;
  let query = "";

  function visibleWords() {
    const q = query.trim().toLowerCase();
    if (!q) return allWords;
    return allWords.filter(w =>
      w.term.toLowerCase().includes(q) || (w.meaning_cn || "").toLowerCase().includes(q));
  }

  function renderWordList() {
    wcount.textContent = String(allWords.length);
    const list = visibleWords();
    wlist.innerHTML = "";
    if (list.length === 0) {
      wlist.appendChild($(`<p class="muted">${allWords.length === 0 ? "词库为空" : "没有匹配的单词"}</p>`));
      return;
    }
    list.forEach(w => wlist.appendChild(wordRow(w)));
  }

  function wordRow(w) {
    const row = $(`<div class="wrow">
      <div class="wterm"><b>${esc(w.term)}</b> <span class="muted">${esc(w.pos || "")}</span>
        <span class="wmean">${esc(w.meaning_cn)}</span></div>
      <div class="wbtns"><button class="link w-edit">编辑</button><button class="link bad w-del">删除</button></div>
    </div>`);
    row.querySelector(".w-edit").onclick = () => editRow(w, row);
    row.querySelector(".w-del").onclick = async () => {
      if (!await showConfirm({
        title: "删除单词",
        message: `确定删除「${w.term}」？\n它将从所有单元移除，两个孩子的学习记录也会一并删除。`,
        okText: "删除",
        danger: true,
      })) return;
      try {
        await api(`/words/${w.id}`, { method: "DELETE" });
        allWords = allWords.filter(x => x.id !== w.id);
        renderWordList();
      } catch (e) { showToast(e.message, "bad"); }
    };
    return row;
  }

  function editRow(w, row) {
    const form = $(`<div class="wedit">
      <div><b>${esc(w.term)}</b> <span class="muted">（单词拼写不可改；如需修改请删除后重新导入）</span></div>
      <input class="e-meaning" placeholder="中文释义（必填）" />
      <input class="e-pos" placeholder="词性，如 n / v" />
      <input class="e-exen" placeholder="例句（英文）" />
      <input class="e-excn" placeholder="例句（中文）" />
      <div><button class="link e-save">保存</button> <button class="link e-cancel">取消</button> <span class="muted e-msg"></span></div>
    </div>`);
    const meaning = form.querySelector(".e-meaning");
    meaning.value = w.meaning_cn || "";
    form.querySelector(".e-pos").value = w.pos || "";
    form.querySelector(".e-exen").value = w.example_en || "";
    form.querySelector(".e-excn").value = w.example_cn || "";
    form.querySelector(".e-cancel").onclick = () => { row.style.display = ""; form.remove(); };
    form.querySelector(".e-save").onclick = async () => {
      const body = {
        meaning_cn: meaning.value.trim(),
        pos: form.querySelector(".e-pos").value.trim() || null,
        example_en: form.querySelector(".e-exen").value.trim() || null,
        example_cn: form.querySelector(".e-excn").value.trim() || null,
      };
      if (!body.meaning_cn) { form.querySelector(".e-msg").textContent = "释义不能为空"; return; }
      try {
        await api(`/words/${w.id}`, { method: "PUT", body: JSON.stringify(body) });
        Object.assign(w, body);
        renderWordList();
      } catch (e) { form.querySelector(".e-msg").textContent = e.message; }
    };
    row.style.display = "none";
    row.after(form);
    meaning.focus();
  }

  wsearch.oninput = () => { query = wsearch.value; renderWordList(); };
  renderWordList();
  if (flash) wrap.querySelector("#r_result").textContent = flash;
  render(wrap);
}
boot();
