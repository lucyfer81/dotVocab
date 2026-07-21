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

async function dashboard() {
  const [units, words, progress] = await Promise.all([api("/units"), api("/words"), api("/progress")]);
  const wrap = $(`<section>
    <header class="top"><h1>家长后台</h1><button class="link" id="out">退出</button></header>
    <h2>进度</h2><div id="prog"></div>
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
    <h2>词库 (${words.length})</h2><div id="wlist"></div>
  </section>`);
  wrap.querySelector("#out").onclick = () => { token=""; localStorage.removeItem("dotvocab_admin_token"); loginView(); };
  wrap.querySelector("#prog").innerHTML = progress.map(u =>
    `<div class="stat">${u.avatar} ${esc(u.name)} — ⭐${u.stars} 🔥${u.streak_days} 已掌握${u.mastered}</div>`).join("");
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
  wrap.querySelector("#wlist").innerHTML = words.map(w =>
    `<div class="stat">${esc(w.term)} — ${esc(w.meaning_cn)} <span class="muted">${esc(w.pos||"")}</span></div>`).join("");
  render(wrap);
}
boot();
