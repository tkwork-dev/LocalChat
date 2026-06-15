/* 図エラー検証ラボ: Mermaid（ブラウザ内）/ PlantUML（サーバー）検証 */
(function () {
  function $(id) { return document.getElementById(id); }

  function resolveMermaid() {
    if (window.mermaid && typeof window.mermaid.render === "function") return window.mermaid;
    var ns = window.__esbuild_esm_mermaid_nm;
    if (ns && ns.mermaid && typeof ns.mermaid.render === "function") return ns.mermaid;
    return null;
  }

  // ===== サンプル =====
  var SAMPLES = {
    class:
      "classDiagram\n" +
      "  class Settings {\n" +
      "    +str HOST\n" +
      "    +int PORT\n" +
      "    +str SECRET_KEY\n" +
      "    +bool RESTRICT_TO_PRIVATE\n" +
      "    +ensure_dirs()\n" +
      "  }\n\n" +
      "  class ConnectionManager {\n" +
      "    -dict connections\n" +
      "    -Lock lock\n" +
      "    +connect(user_id, ws)\n" +
      "    +send_to_users(user_ids, message)\n" +
      "    +online_user_ids() list\n" +
      "  }\n\n" +
      "  class SecurityService {\n" +
      "    <<module>>\n" +
      "    +hash_password(pw) str\n" +
      "    +decode_access_token(token) int\n" +
      "  }\n\n" +
      "  class ServerMember {\n" +
      "    +str role\n" +
      "  }\n\n" +
      "  ConnectionManager ..> SecurityService : verify token\n" +
      "  SecurityService ..> Settings : SECRET_KEY",
    flow:
      "flowchart TD\n" +
      "  A([\u958b\u59cb]) --> B{\u6761\u4ef6}\n" +
      "  B -- \u306f\u3044 --> C[\u51e6\u7406]\n" +
      "  B -- \u3044\u3044\u3048 --> D([\u7d42\u4e86])\n" +
      "  C --> D",
    seq:
      "sequenceDiagram\n" +
      "  autonumber\n" +
      "  actor U as User\n" +
      "  participant API\n" +
      "  U->>API: POST /login\n" +
      "  API-->>U: 200 token",
    er:
      "erDiagram\n" +
      "  USER ||--o{ MESSAGE : authors\n" +
      "  USER {\n" +
      "    int id PK\n" +
      "    string username UK\n" +
      "  }\n" +
      "  MESSAGE {\n" +
      "    int id PK\n" +
      "    int author_id FK\n" +
      "    string content\n" +
      "  }",
  };

  var PUML_SAMPLES = {
    seq: "@startuml\nactor User\nUser -> Server: \u30ed\u30b0\u30a4\u30f3\nServer --> User: OK\n@enduml",
    class: "@startuml\nclass User {\n  +id: int\n  +login()\n}\nUser <|-- Admin\n@enduml",
  };

  // ===== Mermaid =====
  var mmdRenderSeq = 0;

  function formatMermaidError(e) {
    if (!e) return "Unknown error";
    var parts = [];
    if (e.message) parts.push(e.message);
    if (e.str && e.str !== e.message) parts.push(e.str);
    if (e.hash) {
      try {
        var h = e.hash;
        if (h.line !== undefined) parts.push("line: " + h.line);
        if (h.expected) parts.push("expected: " + (Array.isArray(h.expected) ? h.expected.join(", ") : h.expected));
        if (h.token) parts.push("token: " + h.token);
      } catch (ignore) {}
    }
    return parts.join("\n");
  }

  async function validateMermaid() {
    var mermaid = resolveMermaid();
    var status = $("mmd-status");
    var errBox = $("mmd-err");
    var out = $("mmd-out");
    var src = $("mmd-src").value;

    errBox.style.display = "none";
    errBox.textContent = "";

    if (!mermaid) {
      status.className = "lab-status err";
      status.textContent = "Mermaidライブラリを読み込めませんでした / Mermaid not loaded";
      return;
    }
    if (!src.trim()) {
      status.textContent = "";
      out.innerHTML = "";
      return;
    }

    var seq = ++mmdRenderSeq;
    // 1) 構文検証
    try {
      await mermaid.parse(src);
    } catch (e) {
      if (seq !== mmdRenderSeq) return;
      status.className = "lab-status err";
      status.textContent = "\u2717 \u69cb\u6587\u30a8\u30e9\u30fc / Syntax error";
      errBox.style.display = "block";
      errBox.textContent = formatMermaidError(e);
      out.innerHTML = "";
      return;
    }
    // 2) 描画
    try {
      var id = "lab_mmd_" + Date.now();
      var res = await mermaid.render(id, src);
      if (seq !== mmdRenderSeq) return;
      out.innerHTML = res.svg;
      status.className = "lab-status ok";
      status.textContent = "\u2713 OK \u2014 \u63cf\u753b\u6210\u529f / Rendered";
    } catch (e) {
      if (seq !== mmdRenderSeq) return;
      status.className = "lab-status err";
      status.textContent = "\u2717 \u63cf\u753b\u30a8\u30e9\u30fc / Render error";
      errBox.style.display = "block";
      errBox.textContent = formatMermaidError(e);
    }
  }

  // ===== PlantUML（サーバー） =====
  var PUML_BASE_KEY = "lc_lab_puml_base";
  var PUML_TOKEN_KEY = "lc_lab_puml_token";

  function defaultBase() {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return location.origin;
    }
    return "https://localhost:8000";
  }

  async function renderPuml() {
    var status = $("puml-status");
    var errBox = $("puml-err");
    var out = $("puml-out");
    var base = $("puml-base").value.trim() || defaultBase();
    var token = $("puml-token").value.trim();
    var src = $("puml-src").value;

    localStorage.setItem(PUML_BASE_KEY, base);
    localStorage.setItem(PUML_TOKEN_KEY, token);

    errBox.style.display = "none";
    errBox.textContent = "";

    if (!src.trim()) { status.textContent = ""; out.innerHTML = ""; return; }
    if (!token) {
      status.className = "lab-status err";
      status.textContent = "\u2717 \u30c8\u30fc\u30af\u30f3\u304c\u5fc5\u8981\u3067\u3059 / Token required";
      return;
    }

    status.className = "lab-status";
    status.textContent = "\u2026 \u30b5\u30fc\u30d0\u30fc\u306b\u30ea\u30af\u30a8\u30b9\u30c8\u4e2d / requesting";

    try {
      var res = await fetch(base.replace(/\/+$/, "") + "/api/render/plantuml", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ source: src }),
      });
      if (!res.ok) {
        status.className = "lab-status err";
        status.textContent = "\u2717 HTTP " + res.status;
        errBox.style.display = "block";
        errBox.textContent = "HTTP " + res.status + " " + res.statusText +
          "\n\u8a8d\u8a3c\u30c8\u30fc\u30af\u30f3\u30fbURL\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044 / check token & URL";
        out.innerHTML = "";
        return;
      }
      var data = await res.json();
      if (!data.available) {
        status.className = "lab-status err";
        status.textContent = "\u2717 PlantUML\u672a\u5bfe\u5fdc / not available";
        errBox.style.display = "block";
        errBox.textContent =
          "\u30b5\u30fc\u30d0\u30fc\u306b plantuml.jar / JRE \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002" +
          "\n(PLANTUML_JAR / JAVA_BIN \u3092\u78ba\u8a8d) / jar or JRE not configured on server.";
        out.innerHTML = "";
        return;
      }
      if (!data.svg) {
        status.className = "lab-status err";
        status.textContent = "\u2717 \u63cf\u753b\u30a8\u30e9\u30fc / render error";
        errBox.style.display = "block";
        errBox.textContent = data.error || "PlantUML\u306e\u63cf\u753b\u306b\u5931\u6557\u3057\u307e\u3057\u305f / failed";
        out.innerHTML = "";
        return;
      }
      out.innerHTML = data.svg;
      status.className = "lab-status ok";
      status.textContent = "\u2713 OK \u2014 \u63cf\u753b\u6210\u529f / Rendered";
    } catch (e) {
      status.className = "lab-status err";
      status.textContent = "\u2717 \u901a\u4fe1\u30a8\u30e9\u30fc / network or CORS error";
      errBox.style.display = "block";
      errBox.textContent = (e && e.message ? e.message : String(e)) +
        "\n\nCORS\u306e\u53ef\u80fd\u6027\uff1a\u30b5\u30fc\u30d0\u30fc\u3068\u540c\u4e00\u30aa\u30ea\u30b8\u30f3\u3067\u958b\u3044\u3066\u304f\u3060\u3055\u3044\u3002" +
        "\n(Possibly CORS: open this page from the same origin as the server.)";
      out.innerHTML = "";
    }
  }

  // ===== 初期化 =====
  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function setupTabs() {
    var tM = $("tab-mermaid"), tP = $("tab-puml");
    var pM = $("pane-mermaid"), pP = $("pane-puml");
    tM.addEventListener("click", function () {
      tM.classList.add("active"); tP.classList.remove("active");
      pM.classList.add("active"); pP.classList.remove("active");
    });
    tP.addEventListener("click", function () {
      tP.classList.add("active"); tM.classList.remove("active");
      pP.classList.add("active"); pM.classList.remove("active");
    });
  }

  function init() {
    var mermaid = resolveMermaid();
    if (mermaid) {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      } catch (e) {}
    }
    setupTabs();

    // Mermaid イベント
    var autoValidate = debounce(function () {
      if ($("mmd-auto").checked) validateMermaid();
    }, 350);
    $("mmd-src").addEventListener("input", autoValidate);
    $("mmd-run").addEventListener("click", validateMermaid);
    $("mmd-clear").addEventListener("click", function () {
      $("mmd-src").value = ""; $("mmd-out").innerHTML = "";
      $("mmd-status").textContent = ""; $("mmd-err").style.display = "none";
    });
    document.querySelectorAll("[data-sample]").forEach(function (b) {
      b.addEventListener("click", function () {
        $("mmd-src").value = SAMPLES[b.getAttribute("data-sample")] || "";
        validateMermaid();
      });
    });

    // PlantUML イベント
    $("puml-base").value = localStorage.getItem(PUML_BASE_KEY) || defaultBase();
    $("puml-token").value = localStorage.getItem(PUML_TOKEN_KEY) || "";
    $("puml-run").addEventListener("click", renderPuml);
    $("puml-clear").addEventListener("click", function () {
      $("puml-src").value = ""; $("puml-out").innerHTML = "";
      $("puml-status").textContent = ""; $("puml-err").style.display = "none";
    });
    document.querySelectorAll("[data-puml-sample]").forEach(function (b) {
      b.addEventListener("click", function () {
        $("puml-src").value = PUML_SAMPLES[b.getAttribute("data-puml-sample")] || "";
      });
    });

    // 初期サンプル（問題のクラス図を読み込んで即検証）
    $("mmd-src").value = SAMPLES.class;
    validateMermaid();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
