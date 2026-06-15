/* LocalChat 設計書: 日本語 / 英語 表示切り替え（オフライン・依存なし）
 *
 * - テキスト: data-ja / data-en 属性を持つ要素の innerHTML を差し替える。
 *   （インラインHTMLは &lt; などのエンティティで記述しておくと安全）
 * - 図: <pre class="mermaid" data-lang="ja|en"> を言語別に表示切り替えする。
 * - Mermaid 本体の解決・初期化・描画も本スクリプトが担う。
 */
(function () {
  var KEY = "lc_doc_lang";

  function currentLang() {
    var v = localStorage.getItem(KEY);
    return v === "en" ? "en" : "ja";
  }

  function resolveMermaid() {
    if (window.mermaid && typeof window.mermaid.initialize === "function") {
      return window.mermaid;
    }
    var ns = window.__esbuild_esm_mermaid_nm;
    if (ns && ns.mermaid && typeof ns.mermaid.initialize === "function") {
      window.mermaid = ns.mermaid;
      return ns.mermaid;
    }
    return null;
  }

  function applyText(lang) {
    document.querySelectorAll("[data-ja]").forEach(function (el) {
      var val = el.getAttribute("data-" + lang);
      if (val !== null) el.innerHTML = val;
    });
    // title 属性などプレーン文字列用
    document.querySelectorAll("[data-ja-text]").forEach(function (el) {
      var val = el.getAttribute("data-" + lang + "-text");
      if (val !== null) el.textContent = val;
    });
  }

  function applyDiagrams(lang) {
    document.querySelectorAll("pre.mermaid[data-lang]").forEach(function (el) {
      el.style.display = el.getAttribute("data-lang") === lang ? "" : "none";
    });
  }

  function updateButtons(lang) {
    document.querySelectorAll("[data-set-lang]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-set-lang") === lang);
    });
  }

  function apply(lang) {
    document.documentElement.lang = lang;
    applyText(lang);
    applyDiagrams(lang);
    updateButtons(lang);
  }

  function setLang(lang) {
    localStorage.setItem(KEY, lang);
    apply(lang);
  }

  function injectToggle() {
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar) return;
    var anchor = sidebar.querySelector(".sub");
    var box = document.createElement("div");
    box.className = "lang-toggle";
    box.innerHTML =
      '<button type="button" data-set-lang="ja">日本語</button>' +
      '<button type="button" data-set-lang="en">English</button>';
    box.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        setLang(b.getAttribute("data-set-lang"));
      });
    });
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
    } else {
      sidebar.insertBefore(box, sidebar.firstChild);
    }
  }

  function initMermaid() {
    var mermaid = resolveMermaid();
    if (!mermaid) {
      document.querySelectorAll(".mermaid").forEach(function (el) {
        if (el.dataset.errShown) return;
        el.dataset.errShown = "1";
        var msg = document.createElement("div");
        msg.style.color = "#d64545";
        msg.style.fontSize = "13px";
        msg.style.marginBottom = "8px";
        msg.textContent =
          "Mermaidライブラリを読み込めませんでした / Failed to load Mermaid. " +
          "frontend/static/vendor/mermaid.min.js への相対パスを確認してください。";
        el.parentNode.insertBefore(msg, el);
      });
      return;
    }
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
      flowchart: { useMaxWidth: true, curve: "basis" },
      sequence: { useMaxWidth: true, showSequenceNumbers: true },
      er: { useMaxWidth: true },
    });
    try {
      if (typeof mermaid.run === "function") {
        mermaid.run({ querySelector: "pre.mermaid" });
      } else if (typeof mermaid.init === "function") {
        mermaid.init(undefined, document.querySelectorAll("pre.mermaid"));
      }
    } catch (e) {
      /* 個別図の構文エラーは mermaid が要素内に表示する */
    }
  }

  function init() {
    injectToggle();
    apply(currentLang());
    initMermaid();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
