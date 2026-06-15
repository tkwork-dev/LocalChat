/* LocalChat 軽量 Markdown レンダラ（依存なし・XSS安全・完全オフライン）
 *
 * 対応記法: 見出し / 太字 / 斜体 / 取り消し線 / インラインコード /
 *          コードブロック / 引用 / 箇条書き・番号付きリスト / 水平線 /
 *          リンク / テーブル(GFM) / メンション
 * コードブロックの言語が mermaid / plantuml(puml) の場合は図のプレース
 * ホルダを出力し、表示側（app.js）で描画する。
 */
(function (global) {
  "use strict";

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 安全な URL のみ許可（javascript: 等を排除）
  function sanitizeUrl(url) {
    const u = url.trim();
    if (/^(https?:\/\/|mailto:|\/|#|\?)/i.test(u)) return u;
    return "#";
  }

  // ---- インライン処理 ----
  function renderInline(text, opts) {
    opts = opts || {};
    const codeTokens = [];

    // 1. インラインコードを退避（中身は整形対象外）
    let s = text.replace(/`([^`]+)`/g, (m, code) => {
      codeTokens.push("<code>" + escapeHtml(code) + "</code>");
      return "\u0000C" + (codeTokens.length - 1) + "\u0000";
    });

    // 2. 残りを HTML エスケープ
    s = escapeHtml(s);

    // 3. リンク [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const safe = sanitizeUrl(url);
      return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });

    // 4. 太字・斜体・取り消し線
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    // 5. メンション（行頭または空白の直後のみ。URL内の@を誤検出しない）
    s = s.replace(/(^|\s)@([A-Za-z0-9_\-]{2,50})/g, (m, pre, name) => {
      const known = opts.mentionExists ? opts.mentionExists(name) : true;
      return known ? `${pre}<span class="mention">@${name}</span>` : m;
    });

    // 6. インラインコードを復元
    s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => codeTokens[+i]);
    return s;
  }

  // ---- 図プレースホルダ ----
  let diagramSeq = 0;
  function diagramBlock(type, code) {
    const id = "dg" + (diagramSeq++) + "_" + Math.random().toString(36).slice(2, 8);
    return (
      `<div class="diagram" data-type="${type}" data-id="${id}">` +
      `<code class="diagram-source" style="display:none">${escapeHtml(code)}</code>` +
      `<div class="diagram-output">図を描画中…</div></div>`
    );
  }

  // ---- ブロック処理 ----
  function render(text, opts) {
    opts = opts || {};
    const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    function isBlank(l) { return /^\s*$/.test(l); }

    while (i < lines.length) {
      let line = lines[i];

      // コードブロック ``` または ~~~
      const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
      if (fence) {
        const marker = fence[1][0];
        const lang = (fence[2] || "").toLowerCase();
        const body = [];
        i++;
        while (i < lines.length && !new RegExp("^\\s*" + marker + "{3,}\\s*$").test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // 閉じフェンスをスキップ
        const code = body.join("\n");
        if (lang === "mermaid") {
          out.push(diagramBlock("mermaid", code));
        } else if (lang === "plantuml" || lang === "puml" || lang === "uml") {
          out.push(diagramBlock("plantuml", code));
        } else {
          const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
          out.push(`<pre class="code-block"><code${cls}>${escapeHtml(code)}</code></pre>`);
        }
        continue;
      }

      // 空行
      if (isBlank(line)) { i++; continue; }

      // フェンス無しの PlantUML（@startuml … @enduml 等）も図として扱う
      if (/^\s*@start\w*/i.test(line)) {
        const body = [line];
        i++;
        while (i < lines.length) {
          body.push(lines[i]);
          const end = /^\s*@end\w*/i.test(lines[i]);
          i++;
          if (end) break;
        }
        out.push(diagramBlock("plantuml", body.join("\n")));
        continue;
      }

      // 見出し
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        out.push(`<h${level}>${renderInline(h[2].trim(), opts)}</h${level}>`);
        i++;
        continue;
      }

      // 水平線
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        out.push("<hr />");
        i++;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${render(quote.join("\n"), opts)}</blockquote>`);
        continue;
      }

      // テーブル（GFM）: 現在行に | があり、次行が区切り行
      if (line.indexOf("|") !== -1 && i + 1 < lines.length &&
          /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) &&
          lines[i + 1].indexOf("-") !== -1) {
        const tbl = parseTable(lines, i, opts);
        if (tbl) { out.push(tbl.html); i = tbl.next; continue; }
      }

      // リスト
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const lst = parseList(lines, i, opts);
        out.push(lst.html);
        i = lst.next;
        continue;
      }

      // 段落
      const para = [];
      while (i < lines.length && !isBlank(lines[i]) &&
             !/^\s*(`{3,}|~{3,})/.test(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) &&
             !/^\s*>\s?/.test(lines[i]) &&
             !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) &&
             !/^\s*([-*_])\s*(\2\s*){2,}$/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      const joined = para.map((l) => renderInline(l, opts)).join("<br />");
      out.push(`<p>${joined}</p>`);
    }

    return out.join("\n");
  }

  // ---- テーブル解析 ----
  function parseTable(lines, start, opts) {
    function cells(row) {
      let r = row.trim();
      if (r.startsWith("|")) r = r.slice(1);
      if (r.endsWith("|")) r = r.slice(0, -1);
      return r.split("|").map((c) => c.trim());
    }
    const header = cells(lines[start]);
    const aligns = cells(lines[start + 1]).map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].indexOf("|") !== -1 && !/^\s*$/.test(lines[i])) {
      rows.push(cells(lines[i]));
      i++;
    }
    const th = header
      .map((c, idx) => `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(c, opts)}</th>`)
      .join("");
    const body = rows
      .map((r) => "<tr>" + header.map((_, idx) =>
        `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(r[idx] || "", opts)}</td>`
      ).join("") + "</tr>")
      .join("");
    return {
      html: `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`,
      next: i,
    };
  }

  // ---- リスト解析（ネスト対応） ----
  function parseList(lines, start, opts) {
    function indentOf(l) { return l.match(/^\s*/)[0].length; }
    function marker(l) { return l.match(/^\s*([-*+]|\d+\.)\s+/); }

    const baseIndent = indentOf(lines[start]);
    const ordered = /^\s*\d+\./.test(lines[start]);
    const items = [];
    let i = start;

    while (i < lines.length) {
      const m = marker(lines[i]);
      if (!m) break;
      const ind = indentOf(lines[i]);
      if (ind < baseIndent) break;

      if (ind > baseIndent) {
        // ネストしたリスト → 直前の項目に追記
        const sub = parseList(lines, i, opts);
        if (items.length) items[items.length - 1].sub = sub.html;
        i = sub.next;
        continue;
      }

      // 同レベルの項目
      const content = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, "");
      items.push({ content, sub: "" });
      i++;
    }

    const tag = ordered ? "ol" : "ul";
    const html = `<${tag}>` + items
      .map((it) => `<li>${renderInline(it.content, opts)}${it.sub || ""}</li>`)
      .join("") + `</${tag}>`;
    return { html, next: i };
  }

  const LCMarkdown = { render, renderInline, escapeHtml };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = LCMarkdown;
  }
  global.LCMarkdown = LCMarkdown;
})(typeof window !== "undefined" ? window : globalThis);
