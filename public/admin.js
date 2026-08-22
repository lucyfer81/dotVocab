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

async function dashboard(flash) {
  const [units, words, progress] = await Promise.all([api("/units"), api("/words"), api("/progress")]);
  const wrap = $(`<section>
    <header class="top"><h1>家长后台</h1><button class="link" id="out">退出</button></header>
    <h2>进度</h2><div id="prog"></div>
    <h2>重置进度</h2>
    <div id="reset">
      <select id="r_scope"><option value="unit">按单元</option><option value="book">按课本</option><option value="global">全局</option></select>
      <select id="r_target"></select>
      <select id="r_user"></select>
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
  wrap.querySelector("#out").onclick = () => { token=""; localStorage.removeItem("dotvocab_admin_token"); loginView(); };
  wrap.querySelector("#prog").innerHTML = progress.map(u =>
    `<div class="stat">${esc(u.avatar)} ${esc(u.name)} — ⭐${u.stars} 🔥${u.streak_days} 已掌握${u.mastered}</div>`).join("");
  const sel = wrap.querySelector("#target");
  units.forEach(u => { const o=document.createElement("option"); o.value=u.id; o.textContent=`${u.book} · ${u.unit}`; sel.appendChild(o); });
  wrap.querySelector("#addunit").onclick = async () => {
    await api("/units",{method:"POST",body:JSON.stringify({book:wrap.querySelector("#book").value.trim(),unit:wrap.querySelector("#unit").value.trim(),sort_key:Number(wrap.querySelector("#sort").value)||0})});
    dashboard();
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
    const body = { scope: rScope.value, user_ids };
    let targetLabel = "全局";
    if (rScope.value === "unit") { body.unit_id = Number(rTarget.value); targetLabel = rTarget.selectedOptions[0]?.textContent || ""; }
    else if (rScope.value === "book") { body.book = rTarget.value; targetLabel = rTarget.value; }
    if (!await showConfirm({
      title: "重置进度",
      message: `确定重置「${targetLabel}」的 ${userLabel} 单元覆盖进度吗？\n相关单词会重新出现；已掌握度与星星保留。`,
      okText: "确认重置",
      danger: true,
    })) return;
    try {
      const r = await api("/reset-progress", { method: "POST", body: JSON.stringify(body) });
      dashboard(`已重置 ${r.deleted} 条覆盖记录`);
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
