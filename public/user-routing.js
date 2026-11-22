// URL 代号 ↔ 用户对照：/xct 直达哥哥，/lcl 直达弟弟。
// 防呆底线：只做全等比较（规范化后），匹配不到返回 null，绝不模糊匹配或回退到另一个人。

export const SLUG_BY_NAME = { "哥哥": "xct", "弟弟": "lcl" };

const NAME_BY_SLUG = Object.fromEntries(
  Object.entries(SLUG_BY_NAME).map(([name, slug]) => [slug, name])
);

// "/xct/" -> "xct"，"/" -> ""，"/foo/bar" -> "foo/bar"；结果小写
export function slugFromPath(pathname) {
  return String(pathname ?? "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

// "xct" -> "哥哥"；未知代号（含空串、多级路径、原型链属性名）-> null
export function nameForSlug(slug) {
  const key = String(slug ?? "").trim().toLowerCase();
  // hasOwnProperty.call：挡住 constructor/toString 等原型链继承名被误判为已知代号
  return Object.prototype.hasOwnProperty.call(NAME_BY_SLUG, key) ? NAME_BY_SLUG[key] : null;
}

// 代号解析到具体用户：名字全等匹配；名字不存在或找不到 -> null
export function resolveUser(slug, users) {
  const name = nameForSlug(slug);
  if (!name) return null;
  return (Array.isArray(users) ? users : []).find((u) => u.name === name) ?? null;
}
