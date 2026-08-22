import { describe, it, expect } from "vitest";
import { confirmHtml, toastHtml } from "../public/ui.js";

describe("confirmHtml", () => {
  it("builds a dialog with title, message and both buttons", () => {
    const html = confirmHtml({ title: "要返回基地吗？", message: "进度已保存", okText: "返回基地", cancelText: "继续任务" });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('class="modal-title"');
    expect(html).toContain("要返回基地吗？");
    expect(html).toContain("进度已保存");
    expect(html).toContain("返回基地");
    expect(html).toContain("继续任务");
    expect(html).toContain("modal-ok");
    expect(html).toContain("modal-cancel");
  });
  it("defaults button labels when omitted", () => {
    const html = confirmHtml({ title: "t", message: "m" });
    expect(html.match(/modal-ok[^>]*>确定</)).toBeTruthy();
    expect(html.match(/modal-cancel[^>]*>取消</)).toBeTruthy();
  });
  it("marks destructive dialogs with a danger class", () => {
    const html = confirmHtml({ title: "t", message: "m", danger: true });
    expect(html).toContain("danger");
    const plain = confirmHtml({ title: "t", message: "m" });
    expect(plain).not.toContain("danger");
  });
  it("escapes html in title, message and button labels", () => {
    const html = confirmHtml({ title: `<x>`, message: `&<b>`, okText: `"<ok>"`, cancelText: `'<c>'` });
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&amp;&lt;b&gt;");
    expect(html).toContain("&quot;&lt;ok&gt;&quot;");
    expect(html).toContain("&#39;&lt;c&gt;&#39;");
    expect(html).not.toContain("<x>");
  });
});

describe("toastHtml", () => {
  it("builds a status toast with the message", () => {
    const html = toastHtml("导入完成");
    expect(html).toContain('role="status"');
    expect(html).toContain("导入完成");
    expect(html).toContain("toast");
  });
  it("defaults to info kind and renders error kind", () => {
    expect(toastHtml("hi")).toContain("toast info");
    expect(toastHtml("坏了", "bad")).toContain("toast bad");
  });
  it("escapes html in message", () => {
    expect(toastHtml("<img>")).toContain("&lt;img&gt;");
    expect(toastHtml("<img>")).not.toContain("<img>");
  });
});
