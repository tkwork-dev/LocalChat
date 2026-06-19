/* LocalChat クライアント（バニラJS、外部依存なし） */
"use strict";

// ===== グローバル状態 =====
const ACCOUNTS_KEY = "lc_accounts";
const ACTIVE_KEY = "lc_active_token";

const state = {
  token: localStorage.getItem(ACTIVE_KEY) || localStorage.getItem("lc_token") || null,
  user: null,
  servers: [],
  dms: [],
  users: [],
  view: "server",        // "server" | "dm"
  currentServerId: null,
  currentChannelId: null,
  currentDmId: null,
  channels: [],
  members: [],
  ws: null,
  messages: [],          // 現在表示中のメッセージ
  replyTo: null,         // 返信先メッセージID
  editingId: null,       // 編集中メッセージID（インライン編集）
  pendingAttachments: [], // 送信前の添付（{id, filename}）
  unread: { channels: {}, dms: {} },
};
// よく使う絵文字（ローカル＝Unicode絵文字。外部CDN不使用）
const EMOJIS = ["👍","👎","😀","😂","😍","😎","😢","😡","🎉","🙏","🔥","💯",
  "❤️","✅","❌","👀","🚀","💡","🤔","😅","👏","🙌","💪","🍻"];

// ===== ユーティリティ =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function initials(name) {
  return (name || "?").trim().slice(0, 2).toUpperCase();
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `今日 ${time}`;
  return `${d.toLocaleDateString("ja-JP")} ${time}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

// ===== API ヘルパ =====
async function api(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    // 起動時などの「トークン検証」呼び出しでは副作用を起こさず投げるだけにする
    if (!options.skipAuthRedirect) handleSessionExpired();
    const err = new Error("認証エラー");
    err.authFailed = true;
    throw err;
  }
  if (!res.ok) {
    let detail = "エラーが発生しました";
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}

// ===== アカウント管理（複数アカウント切り替え） =====
function loadAccounts() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || []; }
  catch (e) { return []; }
}
function saveAccounts(list) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}
function setActiveToken(token) {
  state.token = token;
  localStorage.setItem(ACTIVE_KEY, token);
  localStorage.setItem("lc_token", token); // 後方互換
}
function upsertAccount(token, user) {
  // 同一ユーザーIDの古いエントリを除いて追加（トークン更新）
  const list = loadAccounts().filter((a) => a.id !== user.id);
  list.push({
    token,
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url || null,
  });
  saveAccounts(list);
  setActiveToken(token);
}
function removeAccount(id) {
  saveAccounts(loadAccounts().filter((a) => a.id !== id));
}
function markWsIntentionalClose() {
  if (state.ws) {
    state.ws._intentional = true;
    try { state.ws.close(); } catch (e) {}
    state.ws = null;
  }
}
function resetAppState() {
  markWsIntentionalClose();
  Object.assign(state, {
    user: null, servers: [], dms: [], users: [], view: "server",
    currentServerId: null, currentChannelId: null, currentDmId: null,
    channels: [], members: [], messages: [], replyTo: null, editingId: null,
    pendingAttachments: [], unread: { channels: {}, dms: {} },
  });
}
async function switchAccount(token) {
  closeModal();
  resetAppState();
  setActiveToken(token);
  try {
    // まずトークンの有効性を確認（副作用なしで検証）
    state.user = await api("/api/auth/me", { skipAuthRedirect: true });
    await startApp();
  } catch (e) {
    // トークンが無効なら、そのアカウントを外してログイン画面へ
    const acc = loadAccounts().find((a) => a.token === token);
    if (acc) removeAccount(acc.id);
    goToLogin();
  }
}

// ログイン画面へ戻す（保存済みトークンはクリアするがアカウント一覧は保持）
function goToLogin() {
  markWsIntentionalClose();
  localStorage.removeItem(ACTIVE_KEY);
  localStorage.removeItem("lc_token");
  state.token = null;
  state.user = null;
  showAuthView(false);
}

// 実行中にトークンが失効した場合（401）の処理。連鎖を避けるため切替はしない。
let _handlingExpiry = false;
function handleSessionExpired() {
  if (_handlingExpiry) return;
  _handlingExpiry = true;
  try {
    if (state.user) removeAccount(state.user.id);
    goToLogin();
  } finally {
    _handlingExpiry = false;
  }
}

// ===== 認証 =====
let authMode = "login";

function showAuthView(forAdd = false) {
  $("#app-view").style.display = "none";
  $("#auth-view").style.display = "flex";
  $("#auth-back").style.display = (forAdd && loadAccounts().length > 0) ? "block" : "none";
  $("#auth-username").value = "";
  $("#auth-password").value = "";
  $("#auth-displayname").value = "";
  $("#auth-error").textContent = "";
}

function setupAuth() {
  $$(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      authMode = tab.dataset.mode;
      $$(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      $("#displayname-field").style.display = authMode === "register" ? "block" : "none";
      $("#auth-submit").textContent = authMode === "register" ? "登録する" : "ログイン";
      $("#auth-error").textContent = "";
    });
  });

  $("#auth-back").addEventListener("click", () => {
    // アカウント追加をキャンセルして現在のアカウントに戻る
    $("#auth-view").style.display = "none";
    $("#app-view").style.display = "flex";
  });

  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("#auth-username").value.trim();
    const password = $("#auth-password").value;
    const displayName = $("#auth-displayname").value.trim();
    $("#auth-error").textContent = "";
    try {
      let result;
      if (authMode === "register") {
        result = await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ username, display_name: displayName || username, password }),
        });
      } else {
        result = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username, password }),
        });
      }
      // 別アカウントを追加する場合に備え、現在の接続をリセットしてから切り替える
      resetAppState();
      upsertAccount(result.access_token, result.user);
      state.user = result.user;
      await startApp();
    } catch (err) {
      $("#auth-error").textContent = err.message;
    }
  });
}

function logout() {
  // 現在のアカウントを一覧から削除し、残りがあれば切り替える
  if (state.user) removeAccount(state.user.id);
  markWsIntentionalClose();
  const remaining = loadAccounts();
  if (remaining.length > 0) {
    switchAccount(remaining[0].token);
  } else {
    localStorage.removeItem(ACTIVE_KEY);
    localStorage.removeItem("lc_token");
    state.token = null;
    state.user = null;
    showAuthView(false);
  }
}

// ===== アプリ起動 =====
async function startApp() {
  $("#auth-view").style.display = "none";
  $("#app-view").style.display = "flex";

  if (!state.user) {
    state.user = await api("/api/auth/me");
  }
  // 現在のアカウントを一覧に同期（旧バージョン互換・情報更新）
  upsertAccount(state.token, state.user);
  renderMyProfile();
  requestNotificationPermission();

  await Promise.all([loadServers(), loadDMs(), loadUsers()]);
  await refreshUnread();
  connectWebSocket();

  // 初期表示：最初のサーバー、なければDM
  if (state.servers.length > 0) {
    await selectServer(state.servers[0].id);
  } else {
    showDMHome();
  }
}

// ===== プロフィール表示 =====
function renderMyProfile() {
  $("#my-name").textContent = state.user.display_name;
  $("#my-status").textContent = state.user.status_message || "オンライン";
  const av = $("#my-avatar");
  av.innerHTML = avatarHtml(state.user);
}

function avatarHtml(user) {
  if (user.avatar_url) {
    return `<img src="${escapeHtml(user.avatar_url)}" alt="" />`;
  }
  return escapeHtml(initials(user.display_name));
}

// ===== サーバー読み込み =====
async function loadServers() {
  state.servers = await api("/api/servers");
  renderServerBar();
}

function renderServerBar() {
  const list = $("#server-list");
  list.innerHTML = "";
  state.servers.forEach((s) => {
    const el = document.createElement("div");
    el.className = "server-icon" + (s.id === state.currentServerId ? " active" : "");
    el.title = s.name;
    el.textContent = initials(s.name);
    el.onclick = () => selectServer(s.id);
    list.appendChild(el);
  });
}

async function loadUsers() {
  state.users = await api("/api/users");
}

// ===== サーバー選択 =====
// 画面遷移トークン。遷移ごとに加算し、古い非同期処理(await後)を打ち切る。
let navSeq = 0;

async function selectServer(serverId) {
  const nav = ++navSeq;
  state.view = "server";
  state.currentServerId = serverId;
  state.currentDmId = null;
  $("#dm-home").classList.remove("active");
  renderServerBar();

  const server = state.servers.find((s) => s.id === serverId);
  $("#current-server-name").textContent = server ? server.name : "";
  $("#channel-section").style.display = "block";
  $("#dm-section").style.display = "none";

  // チャンネルとメンバーを並列取得（直列の待ち時間を短縮）
  const [channels, members] = await Promise.all([
    api(`/api/servers/${serverId}/channels`),
    api(`/api/servers/${serverId}/members`),
  ]);
  if (nav !== navSeq) return; // 別の遷移が始まっていたら中断
  state.channels = channels;
  state.members = members;
  renderChannels();
  renderMembers();
  updateInviteButton();

  if (state.channels.length > 0) {
    await selectChannel(state.channels[0].id);
  } else {
    clearChatArea();
  }
}

function renderChannels() {
  const list = $("#channel-list");
  list.innerHTML = "";
  state.channels.forEach((c) => {
    const el = document.createElement("div");
    el.className = "channel-item" + (c.id === state.currentChannelId ? " active" : "");
    const unread = state.unread.channels[c.id] || 0;
    el.innerHTML = `<span class="hash">#</span>
      <span class="ch-name">${escapeHtml(c.name)}</span>
      ${unread ? `<span class="channel-badge">${unread}</span>` : ""}`;
    el.onclick = () => selectChannel(c.id);
    list.appendChild(el);
  });
}

function renderMembers() {
  const list = $("#member-list");
  list.innerHTML = "";
  const roleOrder = { admin: 0, moderator: 1, member: 2 };
  const sorted = [...state.members].sort(
    (a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9)
  );
  sorted.forEach((m) => {
    const el = document.createElement("div");
    el.className = "member-item";
    const roleLabel = m.role === "admin" ? "管理者" : m.role === "moderator" ? "モデレーター" : "";
    el.innerHTML = `<div class="avatar">${avatarHtml(m.user)}</div>
      <div style="flex:1;min-width:0;">
        <div class="member-name role-${m.role}">${escapeHtml(m.user.display_name)}</div>
        ${roleLabel ? `<div class="member-role">${roleLabel}</div>` : ""}
      </div>`;
    el.onclick = () => openUserMenu(m);
    list.appendChild(el);
  });
}

// ===== チャンネル選択 =====
async function selectChannel(channelId) {
  const nav = ++navSeq;
  if (state.editingId) cancelEdit();
  state.currentChannelId = channelId;
  state.currentDmId = null;
  state.replyTo = null;
  cancelReply();
  renderChannels();

  const ch = state.channels.find((c) => c.id === channelId);
  $("#chat-title").textContent = "# " + (ch ? ch.name : "");
  $("#chat-topic").textContent = ch && ch.topic ? ch.topic : "";

  const msgs = await api(`/api/channels/${channelId}/messages`);
  if (nav !== navSeq) return; // 別の遷移が始まっていたら中断
  state.messages = msgs;
  renderMessages();
  await markRead();
}

function clearChatArea() {
  $("#chat-title").textContent = "# チャンネルを選択";
  $("#chat-topic").textContent = "";
  $("#messages").innerHTML = `<div class="empty-state">チャンネルがありません。左の + から作成してください。</div>`;
}

function myRole() {
  const me = state.members.find((m) => m.user.id === state.user.id);
  return me ? me.role : null;
}

function updateInviteButton() {
  const btn = $("#open-invite");
  const role = myRole();
  btn.style.display =
    state.view === "server" && (role === "admin" || role === "moderator")
      ? "block"
      : "none";
}

// ===== DM =====
async function loadDMs() {
  state.dms = await api("/api/dms");
}

function showDMHome() {
  state.view = "dm";
  state.currentServerId = null;
  state.currentChannelId = null;
  $("#dm-home").classList.add("active");
  renderServerBar();
  $("#current-server-name").textContent = "ダイレクトメッセージ";
  $("#channel-section").style.display = "none";
  $("#dm-section").style.display = "block";
  $("#member-bar").style.display = "none";
  $("#open-invite").style.display = "none";
  renderDMList();
  if (state.dms.length > 0) {
    selectDM(state.dms[0].id);
  } else {
    $("#chat-title").textContent = "ダイレクトメッセージ";
    $("#chat-topic").textContent = "";
    $("#messages").innerHTML = `<div class="empty-state">DMはまだありません。+ から開始してください。</div>`;
  }
}

function dmTitle(dm) {
  if (dm.name) return dm.name;
  const others = dm.members.filter((u) => u.id !== state.user.id);
  if (others.length === 0) return "自分";
  return others.map((u) => u.display_name).join(", ");
}

function renderDMList() {
  const list = $("#dm-list");
  list.innerHTML = "";
  state.dms.forEach((dm) => {
    const el = document.createElement("div");
    el.className = "channel-item" + (dm.id === state.currentDmId ? " active" : "");
    const unread = state.unread.dms[dm.id] || 0;
    el.innerHTML = `<div class="avatar" style="width:24px;height:24px;font-size:10px;">${
      dm.is_group ? "G" : escapeHtml(initials(dmTitle(dm)))
    }</div>
      <span class="ch-name">${escapeHtml(dmTitle(dm))}</span>
      ${unread ? `<span class="channel-badge">${unread}</span>` : ""}`;
    el.onclick = () => selectDM(dm.id);
    list.appendChild(el);
  });
}

async function selectDM(dmId) {
  const nav = ++navSeq;
  if (state.editingId) cancelEdit();
  state.view = "dm";
  state.currentDmId = dmId;
  state.currentChannelId = null;
  state.replyTo = null;
  cancelReply();
  renderDMList();
  const dm = state.dms.find((d) => d.id === dmId);
  $("#chat-title").textContent = dm ? dmTitle(dm) : "";
  $("#chat-topic").textContent = "";
  const msgs = await api(`/api/dms/${dmId}/messages`);
  if (nav !== navSeq) return; // 別の遷移が始まっていたら中断
  state.messages = msgs;
  renderMessages();
  await markRead();
}

// ===== メッセージ描画 =====
function renderMessages() {
  const container = $("#messages");
  // 前回のメッセージ群に対する図の遅延描画監視を破棄（参照リーク防止）
  if (_diagramObserver) { _diagramObserver.disconnect(); _diagramObserver = null; }
  container.innerHTML = "";
  if (state.messages.length === 0) {
    container.innerHTML = `<div class="empty-state">まだメッセージがありません。最初の投稿をしましょう。</div>`;
    return;
  }
  // 返信を親メッセージの直下にグルーピングして表示する
  const ordered = buildThreadedOrder(state.messages);
  ordered.forEach((m) => container.appendChild(renderMessage(m)));
  container.scrollTop = container.scrollHeight;
  processDiagrams(container);
}

// メッセージを親子グルーピングで並べ替える
// 親メッセージの直下に返信を配置（返信同士はID順）
function buildThreadedOrder(messages) {
  const roots = [];       // parent_idが無いメッセージ（時系列順）
  const childMap = {};    // parent_id => [返信メッセージ]

  messages.forEach((m) => {
    if (m.parent_id) {
      if (!childMap[m.parent_id]) childMap[m.parent_id] = [];
      childMap[m.parent_id].push(m);
    } else {
      roots.push(m);
    }
  });

  const result = [];
  roots.forEach((m) => {
    result.push(m);
    // 親の直下に返信を挿入
    if (childMap[m.id]) {
      childMap[m.id].forEach((reply) => result.push(reply));
    }
  });

  // 孤立した返信（親がまだ読み込まれていない場合）は末尾に追加
  messages.forEach((m) => {
    if (m.parent_id && !messages.some((p) => p.id === m.parent_id)) {
      if (!result.includes(m)) result.push(m);
    }
  });

  return result;
}

function renderContent(text) {
  // Markdown を安全に HTML 化（メンション強調も内部で処理）
  return LCMarkdown.render(text, {
    mentionExists: (name) => state.users.some((u) => u.username === name),
  });
}

// 図（Mermaid / PlantUML）のレンダリング
// 描画済みSVGを内容(type+コード)単位でキャッシュし、再描画時の重い処理を回避する
const diagramCache = new Map();

function diagramLabel(type) {
  return type === "mermaid" ? "Mermaid" : "PlantUML";
}

// 図は画面に入った時だけ描画する（大量の図を一度に描画してフリーズ/メモリ枯渇するのを防ぐ）
let _diagramObserver = null;
function getDiagramObserver() {
  if (_diagramObserver) return _diagramObserver;
  if (typeof IntersectionObserver === "undefined") return null;
  _diagramObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        obs.unobserve(e.target);
        renderOneDiagram(e.target);
      }
    }
  }, { rootMargin: "300px" });
  return _diagramObserver;
}

// 要素内の図ブロックを遅延描画の監視対象にする（未対応環境では即描画）
function processDiagrams(root) {
  const obs = getDiagramObserver();
  root.querySelectorAll(".diagram").forEach((block) => {
    if (block.dataset.observed || block.dataset.done) return;
    block.dataset.observed = "1";
    if (obs) obs.observe(block);
    else renderOneDiagram(block);
  });
}

async function renderOneDiagram(block) {
  if (block.dataset.done) return;
  block.dataset.done = "1";
  const type = block.dataset.type;
  const srcEl = block.querySelector(".diagram-source");
  const output = block.querySelector(".diagram-output");
  const code = srcEl ? srcEl.textContent : "";
  const key = type + "\n" + code;

  // キャッシュ済みなら即座に再利用（再描画・サーバー通信なし）
  const cached = diagramCache.get(key);
  if (cached) {
    renderDiagramSuccess(output, code, cached, diagramLabel(type));
    return;
  }
  if (type === "mermaid") {
    await renderMermaid(block.dataset.id, code, output, key);
  } else if (type === "plantuml") {
    await renderPlantUml(code, output, key);
  }
}

function showDiagramSource(output, code, note) {
  output.innerHTML =
    (note ? `<div class="diagram-note">${escapeHtml(note)}</div>` : "") +
    `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
}

// 描画成功時：図 + 「ソース表示」トグルボタンを表示
function renderDiagramSuccess(output, code, svg, label) {
  output.innerHTML =
    `<div class="diagram-toolbar">` +
    `<button class="diagram-src-btn">&lt;/&gt; ソース表示</button></div>` +
    `<div class="diagram-svg">${svg}</div>` +
    `<pre class="code-block diagram-src-code" style="display:none"><code>${escapeHtml(code)}</code></pre>`;
  const btn = output.querySelector(".diagram-src-btn");
  const pre = output.querySelector(".diagram-src-code");
  btn.addEventListener("click", () => {
    const hidden = pre.style.display === "none";
    pre.style.display = hidden ? "block" : "none";
    btn.innerHTML = hidden
      ? `&lt;/&gt; ソースを隠す（${label}）`
      : "&lt;/&gt; ソース表示";
  });
}

async function renderMermaid(id, code, output, key) {
  if (!window.mermaid) { showDiagramSource(output, code, "Mermaidライブラリが読み込まれていません"); return; }
  try {
    const { svg } = await window.mermaid.render("mmd_" + id, code);
    if (key) diagramCache.set(key, svg);
    renderDiagramSuccess(output, code, svg, "Mermaid");
  } catch (err) {
    showDiagramSource(output, code, "Mermaid構文エラー: " + (err && err.message ? err.message : err));
  }
}

async function renderPlantUml(code, output, key) {
  try {
    const res = await api("/api/render/plantuml", {
      method: "POST", body: JSON.stringify({ source: code }),
    });
    if (res && res.available && res.svg) {
      if (key) diagramCache.set(key, res.svg);
      renderDiagramSuccess(output, code, res.svg, "PlantUML");
    } else {
      showDiagramSource(output, code,
        "PlantUMLレンダリングは未設定です（管理者が PLANTUML_JAR を設定すると図が表示されます）");
    }
  } catch (err) {
    showDiagramSource(output, code, "PlantUMLの描画に失敗しました");
  }
}

// 返信のネスト深度を算出（最大5段階で制限）
function getReplyDepth(m) {
  let depth = 0;
  let current = m;
  while (current.parent_id && depth < 5) {
    depth++;
    const parent = state.messages.find((p) => p.id === current.parent_id);
    if (!parent) break;
    current = parent;
  }
  return depth;
}

function renderMessage(m) {
  const el = document.createElement("div");
  el.className = m.parent_id ? "msg msg-reply" : "msg";
  el.dataset.id = m.id;
  if (m.parent_id) {
    el.dataset.parent = m.parent_id;
    const depth = getReplyDepth(m);
    el.style.marginLeft = (48 * depth) + "px";
  }

  const isMine = m.author.id === state.user.id;
  let contentHtml;
  if (m.is_deleted) {
    contentHtml = `<div class="msg-content msg-deleted">このメッセージは削除されました</div>`;
  } else {
    contentHtml = `<div class="msg-content">${renderContent(m.content)}${
      m.edited_at ? `<span class="msg-edited">(編集済み)</span>` : ""
    }</div>`;
  }

  // 添付
  let attachHtml = "";
  (m.attachments || []).forEach((a) => {
    const url = `/api/files/${a.id}?token=${encodeURIComponent(state.token)}`;
    const ext = (a.filename || "").split(".").pop().toLowerCase();
    if (a.content_type.startsWith("image/")) {
      attachHtml += `<div class="attachment"><a href="${url}" target="_blank"><img src="${url}" alt="${escapeHtml(a.filename)}" /></a></div>`;
    } else if (a.content_type === "text/html" || ext === "html" || ext === "htm") {
      const frameId = `html-preview-${m.id}-${a.id}`;
      const sourceId = `html-source-${m.id}-${a.id}`;
      attachHtml += `<div class="attachment attachment-html-preview">
        <div class="html-preview-header">
          <span>📄 ${escapeHtml(a.filename)}</span>
          <div class="html-preview-actions">
            <button class="html-preview-btn" data-frame="${frameId}" data-source="${sourceId}" title="ソース表示">&lt;/&gt;</button>
            <a href="${url}" target="_blank" class="html-preview-open" title="新しいタブで開く">↗</a>
          </div>
        </div>
        <iframe id="${frameId}" sandbox="allow-scripts" class="html-preview-frame"></iframe>
        <pre id="${sourceId}" class="html-source-view" style="display:none;"></pre>
      </div>`;
      // HTMLをfetchしてsrcdocに注入＋ソース保持
      fetch(url).then(r => r.text()).then(html => {
        const frame = document.getElementById(frameId);
        if (frame) frame.srcdoc = html;
        const source = document.getElementById(sourceId);
        if (source) source.textContent = html;
      }).catch(() => {});
    } else if (ext === "md" || ext === "markdown") {
      const previewId = `md-preview-${m.id}-${a.id}`;
      const sourceId = `md-source-${m.id}-${a.id}`;
      const openLinkId = `md-open-${m.id}-${a.id}`;
      attachHtml += `<div class="attachment attachment-md-preview">
        <div class="html-preview-header">
          <span>📝 ${escapeHtml(a.filename)}</span>
          <div class="html-preview-actions">
            <button class="html-preview-btn" data-frame="${previewId}" data-source="${sourceId}" title="ソース表示">&lt;/&gt;</button>
            <a id="${openLinkId}" href="#" target="_blank" class="html-preview-open" title="新しいタブで開く">↗</a>
          </div>
        </div>
        <div id="${previewId}" class="md-preview-body msg-content"></div>
        <pre id="${sourceId}" class="html-source-view" style="display:none;"></pre>
      </div>`;
      // MarkdownをfetchしてLCMarkdownでレンダリング
      fetch(url).then(r => r.text()).then(md => {
        const preview = document.getElementById(previewId);
        if (preview) preview.innerHTML = LCMarkdown.render(md);
        const source = document.getElementById(sourceId);
        if (source) source.textContent = md;
        if (preview) processDiagrams(preview);
        // 新しいタブ用にレンダリング済みHTMLのBlobを作成
        const openLink = document.getElementById(openLinkId);
        if (openLink) {
          const rendered = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(a.filename)}</title><style>body{font-family:"Segoe UI","Meiryo",sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto}code{background:#f0f0f0;padding:2px 5px;border-radius:3px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}blockquote{border-left:3px solid #5865f2;margin:8px 0;padding:4px 12px;color:#666}</style></head><body>${LCMarkdown.render(md)}</body></html>`;
          const blob = new Blob([rendered], { type: "text/html" });
          openLink.href = URL.createObjectURL(blob);
        }
      }).catch(() => {});
    } else if (ext === "puml" || ext === "plantuml" || ext === "uml") {
      const previewId = `puml-preview-${m.id}-${a.id}`;
      const sourceId = `puml-source-${m.id}-${a.id}`;
      const openLinkId = `puml-open-${m.id}-${a.id}`;
      attachHtml += `<div class="attachment attachment-puml-preview">
        <div class="html-preview-header">
          <span>🔀 ${escapeHtml(a.filename)}</span>
          <div class="html-preview-actions">
            <button class="html-preview-btn" data-frame="${previewId}" data-source="${sourceId}" title="ソース表示">&lt;/&gt;</button>
            <a id="${openLinkId}" href="#" target="_blank" class="html-preview-open" title="新しいタブで開く">↗</a>
          </div>
        </div>
        <div id="${previewId}" class="puml-preview-body"></div>
        <pre id="${sourceId}" class="html-source-view" style="display:none;"></pre>
      </div>`;
      // PlantUMLをfetchしてレンダリング
      fetch(url).then(r => r.text()).then(puml => {
        const preview = document.getElementById(previewId);
        const source = document.getElementById(sourceId);
        if (source) source.textContent = puml;
        if (preview) {
          api("/api/render/plantuml", {
            method: "POST", body: JSON.stringify({ source: puml }),
          }).then(res => {
            if (res && res.available && res.svg) {
              preview.innerHTML = res.svg;
              // 新しいタブ用にSVGをBlobで開けるようにする
              const openLink = document.getElementById(openLinkId);
              if (openLink) {
                const blob = new Blob([res.svg], { type: "image/svg+xml" });
                openLink.href = URL.createObjectURL(blob);
              }
            } else {
              preview.innerHTML = `<pre class="code-block"><code>${escapeHtml(puml)}</code></pre>`;
            }
          }).catch(() => {
            preview.innerHTML = `<pre class="code-block"><code>${escapeHtml(puml)}</code></pre>`;
          });
        }
      }).catch(() => {});
    } else {
      attachHtml += `<div class="attachment"><a class="attachment-file" href="${url}" target="_blank">📎 ${escapeHtml(a.filename)} <span style="color:var(--text-muted)">(${fmtSize(a.size)})</span></a></div>`;
    }
  });

  // リアクション
  let reactHtml = "";
  if (m.reactions && m.reactions.length) {
    reactHtml = `<div class="reactions">` + m.reactions.map((r) => {
      const mine = r.user_ids.includes(state.user.id);
      return `<span class="reaction ${mine ? "mine" : ""}" data-emoji="${escapeHtml(r.emoji)}">${escapeHtml(r.emoji)} ${r.count}</span>`;
    }).join("") + `</div>`;
  }

  // 返信先の引用表示
  let replyHtml = "";
  if (m.parent_id) {
    const parent = state.messages.find((p) => p.id === m.parent_id);
    if (parent) {
      const snippet = parent.is_deleted ? "削除されたメッセージ" : escapeHtml(parent.content).slice(0, 80);
      replyHtml = `<div class="msg-reply-ref" data-jump="${parent.id}"><span class="reply-author">${escapeHtml(parent.author.display_name)}</span> <span class="reply-snippet">${snippet}</span></div>`;
    } else {
      replyHtml = `<div class="msg-reply-ref"><span class="reply-snippet">元のメッセージ</span></div>`;
    }
  }

  el.innerHTML = `
    <div class="avatar lg">${avatarHtml(m.author)}</div>
    <div class="msg-body">
      ${replyHtml}
      <div class="msg-head">
        <span class="msg-author">${escapeHtml(m.author.display_name)}</span>
        <span class="msg-time">${fmtTime(m.created_at)}</span>
      </div>
      ${contentHtml}
      ${attachHtml}
      ${reactHtml}
    </div>
    <div class="msg-actions">
      <button data-action="reply" title="返信">↩</button>
      <button data-action="react" title="リアクション">😊</button>
      ${isMine && !m.is_deleted ? `<button data-action="edit" title="編集">✏</button>` : ""}
      ${isMine && !m.is_deleted ? `<button data-action="delete" title="削除">🗑</button>` : ""}
    </div>`;

  // アクション
  el.querySelector('[data-action="reply"]')?.addEventListener("click", () => startReply(m));
  el.querySelector('[data-action="react"]')?.addEventListener("click", (e) => {
    showEmojiPickerFor(m.id, e.currentTarget);
  });
  el.querySelector('[data-action="edit"]')?.addEventListener("click", () => editMessage(m));
  el.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteMessage(m));
  el.querySelector('.msg-reply-ref[data-jump]')?.addEventListener("click", (e) => {
    const targetId = e.currentTarget.dataset.jump;
    const targetEl = $(`.msg[data-id="${targetId}"]`);
    if (targetEl) { targetEl.scrollIntoView({ behavior: "smooth", block: "center" }); targetEl.classList.add("msg-highlight"); setTimeout(() => targetEl.classList.remove("msg-highlight"), 1500); }
  });
  el.querySelectorAll(".reaction").forEach((r) => {
    r.addEventListener("click", () => toggleReaction(m.id, r.dataset.emoji));
  });

  // Markdown内の図（Mermaid/PlantUML）はDOM挿入後に processDiagrams で監視する
  return el;
}

// ===== メッセージ送信 =====
async function sendMessage() {
  const input = $("#message-input");
  const content = input.value.trim();

  // 編集モード中は PATCH で更新
  if (state.editingId) {
    const editingId = state.editingId;
    const original = findMessage(editingId);
    if (content === "") {
      // 内容が空なら編集をキャンセル（削除は別操作）
      cancelEdit();
      return;
    }
    if (original && content === original.content) {
      cancelEdit();
      return;
    }
    try {
      await api(`/api/messages/${editingId}`, {
        method: "PATCH", body: JSON.stringify({ content }),
      });
      cancelEdit();
    } catch (err) {
      alert("編集に失敗しました: " + err.message);
    }
    return;
  }

  if (!content && state.pendingAttachments.length === 0) return;

  const body = {
    content,
    parent_id: state.replyTo || null,
    attachment_ids: state.pendingAttachments.map((a) => a.id),
  };

  try {
    if (state.view === "server" && state.currentChannelId) {
      await api(`/api/channels/${state.currentChannelId}/messages`, {
        method: "POST", body: JSON.stringify(body),
      });
    } else if (state.currentDmId) {
      await api(`/api/dms/${state.currentDmId}/messages`, {
        method: "POST", body: JSON.stringify(body),
      });
    } else {
      return;
    }
    input.value = "";
    input.style.height = "auto";
    state.pendingAttachments = [];
    renderAttachmentPreview();
    cancelReply();
  } catch (err) {
    alert("送信に失敗しました: " + err.message);
  }
}

function editMessage(m) {
  // 下のメッセージ入力欄を使ってインライン編集する
  state.editingId = m.id;
  const input = $("#message-input");
  input.value = m.content;
  input.focus();
  // カーソルを末尾へ
  input.setSelectionRange(input.value.length, input.value.length);
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  showEditBanner();
}

function showEditBanner() {
  const banner = $("#reply-banner");
  if (!banner) return;
  $("#reply-text").textContent = "メッセージを編集中（Escでキャンセル）";
  banner.style.display = "flex";
}

function cancelEdit() {
  state.editingId = null;
  const banner = $("#reply-banner");
  if (banner) banner.style.display = "none";
  const input = $("#message-input");
  input.value = "";
  input.style.height = "auto";
}

async function deleteMessage(m) {
  if (!confirm("このメッセージを削除しますか？")) return;
  try {
    await api(`/api/messages/${m.id}`, { method: "DELETE" });
  } catch (err) { alert("削除に失敗しました: " + err.message); }
}

async function toggleReaction(messageId, emoji) {
  // 自分が既に付けているか確認
  const msg = findMessage(messageId);
  const reaction = msg?.reactions.find((r) => r.emoji === emoji);
  const mine = reaction && reaction.user_ids.includes(state.user.id);
  try {
    if (mine) {
      await api(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: "DELETE" });
    } else {
      await api(`/api/messages/${messageId}/reactions`, {
        method: "POST", body: JSON.stringify({ emoji }),
      });
    }
  } catch (err) { alert("リアクションに失敗しました: " + err.message); }
}

function findMessage(id) {
  return state.messages.find((m) => m.id === id);
}

// ===== ファイルアップロード =====
async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const att = await api("/api/files", { method: "POST", body: fd });
    state.pendingAttachments.push(att);
    renderAttachmentPreview();
  } catch (err) { alert("アップロードに失敗しました: " + err.message); }
}

function renderAttachmentPreview() {
  const wrap = $("#attachment-preview");
  wrap.innerHTML = "";
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "preview-chip";
    chip.innerHTML = `📎 ${escapeHtml(a.filename)} <button class="mini-btn">✕</button>`;
    chip.querySelector("button").onclick = () => {
      state.pendingAttachments.splice(i, 1);
      renderAttachmentPreview();
    };
    wrap.appendChild(chip);
  });
}

// ===== 絵文字ピッカー =====
let emojiTarget = null; // {messageId} or null（=入力欄挿入）

function buildEmojiPicker() {
  const picker = $("#emoji-picker");
  picker.innerHTML = "";
  EMOJIS.forEach((e) => {
    const span = document.createElement("span");
    span.textContent = e;
    span.onclick = () => {
      if (emojiTarget) {
        toggleReaction(emojiTarget, e);
      } else {
        const input = $("#message-input");
        input.value += e;
        input.focus();
      }
      picker.style.display = "none";
    };
    picker.appendChild(span);
  });
}

function showEmojiPickerFor(messageId, anchor) {
  emojiTarget = messageId;
  const picker = $("#emoji-picker");
  picker.style.display = "grid";
}

function toggleComposerEmoji() {
  emojiTarget = null;
  const picker = $("#emoji-picker");
  picker.style.display = picker.style.display === "none" ? "grid" : "none";
}

// ===== 返信 =====
function startReply(m) {
  if (state.editingId) cancelEdit();
  state.replyTo = m.id;
  const banner = $("#reply-banner");
  const snippet = m.is_deleted ? "削除されたメッセージ" : m.content.slice(0, 60);
  $("#reply-text").textContent = `${m.author.display_name} に返信: ${snippet}`;
  banner.style.display = "flex";
  $("#message-input").focus();
}

function cancelReply() {
  state.replyTo = null;
  const banner = $("#reply-banner");
  if (banner && !state.editingId) banner.style.display = "none";
}

// ===== WebSocket（リアルタイム） =====
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch (e) { return; }
    handleRealtime(data);
  };
  ws.onclose = () => {
    // 意図的な切断（ログアウト/アカウント切替）では再接続しない
    if (state.token && !ws._intentional) setTimeout(connectWebSocket, 3000);
  };
  // キープアライブ
  ws.onopen = () => {
    if (ws._ping) clearInterval(ws._ping);
    ws._ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25000);
  };
}

function isCurrentTarget(msg) {
  if (msg.channel_id != null) return msg.channel_id === state.currentChannelId;
  if (msg.dm_channel_id != null) return msg.dm_channel_id === state.currentDmId;
  return false;
}

function handleRealtime(data) {
  switch (data.type) {
    case "message_created": {
      const msg = data.message;
      if (isCurrentTarget(msg)) {
        state.messages.push(msg);
        const c = $("#messages");
        const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 100;
        const el = renderMessage(msg);
        if (msg.parent_id) {
          // 返信は親メッセージの直下（既存の返信群の末尾）に挿入
          const siblings = c.querySelectorAll(`.msg[data-parent="${msg.parent_id}"]`);
          if (siblings.length > 0) {
            // 最後の兄弟返信の次に挿入
            siblings[siblings.length - 1].after(el);
          } else {
            // まだ返信がなければ親の直後に挿入
            const parentEl = c.querySelector(`.msg[data-id="${msg.parent_id}"]`);
            if (parentEl) {
              parentEl.after(el);
            } else {
              c.appendChild(el);
            }
          }
        } else {
          c.appendChild(el);
        }
        processDiagrams(c);
        if (atBottom) c.scrollTop = c.scrollHeight;
        if (msg.author.id !== state.user.id) markRead();
      } else {
        // 未読カウント増加
        bumpUnread(msg);
      }
      break;
    }
    case "message_updated": {
      const msg = data.message;
      updateMessageInPlace(msg);
      break;
    }
    case "message_deleted": {
      removeMessageInPlace(data.message_id);
      break;
    }
    case "mention": {
      notifyMention(data.message);
      break;
    }
  }
}

function updateMessageInPlace(msg) {
  const idx = state.messages.findIndex((m) => m.id === msg.id);
  if (idx >= 0) state.messages[idx] = msg;
  if (isCurrentTarget(msg)) {
    const el = $(`.msg[data-id="${msg.id}"]`);
    if (el) { el.replaceWith(renderMessage(msg)); processDiagrams($("#messages")); }
  }
}

function removeMessageInPlace(id) {
  const m = state.messages.find((x) => x.id === id);
  if (m) { m.is_deleted = true; m.content = ""; }
  const el = $(`.msg[data-id="${id}"]`);
  if (el && m) el.replaceWith(renderMessage(m));
}

function bumpUnread(msg) {
  if (msg.channel_id != null) {
    state.unread.channels[msg.channel_id] = (state.unread.channels[msg.channel_id] || 0) + 1;
    renderChannels();
  } else if (msg.dm_channel_id != null) {
    state.unread.dms[msg.dm_channel_id] = (state.unread.dms[msg.dm_channel_id] || 0) + 1;
    if (state.view === "dm") renderDMList();
  }
}

// ===== 既読・未読 =====
async function markRead() {
  try {
    if (state.currentChannelId) {
      await api(`/api/channels/${state.currentChannelId}/read`, { method: "POST" });
      state.unread.channels[state.currentChannelId] = 0;
      renderChannels();
    } else if (state.currentDmId) {
      await api(`/api/dms/${state.currentDmId}/read`, { method: "POST" });
      state.unread.dms[state.currentDmId] = 0;
      renderDMList();
    }
  } catch (e) {}
}

async function refreshUnread() {
  try {
    state.unread = await api("/api/unread");
  } catch (e) { state.unread = { channels: {}, dms: {} }; }
}

// ===== 通知 =====
function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function notifyMention(msg) {
  if ("Notification" in window && Notification.permission === "granted") {
    // ブラウザ標準の通知API。外部Push通知サーバーは経由しない。
    new Notification(`${msg.author.display_name} さんからのメンション`, {
      body: msg.content.slice(0, 120),
    });
  }
}

// ===== モーダル =====
function openModal(html, wide = false) {
  $("#modal").innerHTML = html;
  $("#modal").classList.toggle("modal-wide", !!wide);
  $("#modal-overlay").style.display = "flex";
}
function closeModal() {
  $("#modal-overlay").style.display = "none";
  $("#modal").innerHTML = "";
  $("#modal").classList.remove("modal-wide");
}

// ===== 使い方・Tips（Markdown/図のヘルプ） =====
function modalHelp() {
  // 例文と実レンダリング結果を並べて表示（メンションはプレビュー用に有効化）
  const renderOpts = { mentionExists: () => true };
  const examples = [
    ["見出し", "# 大見出し\n## 中見出し"],
    ["太字 / 斜体", "**太字** と *斜体*"],
    ["取り消し線", "~~取り消し~~"],
    ["インラインコード", "実行は `npm start` で"],
    ["リンク", "[社内ポータル](https://example.com)"],
    ["メンション", "@yamada さん確認お願いします"],
    ["箇条書き", "- 項目A\n- 項目B\n  - ネストB-1"],
    ["番号付きリスト", "1. 準備\n2. 実行\n3. 確認"],
    ["引用", "> これは引用です"],
    ["水平線", "区切り\n\n---"],
    ["テーブル", "| 名前 | 役割 |\n| --- | --- |\n| 田中 | 管理者 |\n| 佐藤 | 一般 |"],
    ["コードブロック", "```python\nprint(\"hello\")\n```"],
  ];

  const rows = examples.map(([title, src]) => `
    <div class="help-row">
      <div class="help-syntax">
        <div class="help-title">${escapeHtml(title)}</div>
        <pre class="code-block"><code>${escapeHtml(src)}</code></pre>
      </div>
      <div class="help-preview msg-content">${LCMarkdown.render(src, renderOpts)}</div>
    </div>`).join("");

  const diagramSection = `
    <h3 class="help-h3">図（ダイアグラム）</h3>
    <p class="help-note">コードブロックの言語に <code>mermaid</code> または <code>plantuml</code> を指定すると図として描画されます。PlantUML は <code>@startuml … @enduml</code> をそのまま貼り付けてもOKです。</p>
    <div class="help-row">
      <div class="help-syntax">
        <div class="help-title">Mermaid（フローチャート）</div>
        <pre class="code-block"><code>${escapeHtml("```mermaid\ngraph TD\n  A[開始] --> B{条件}\n  B -->|はい| C[処理]\n  B -->|いいえ| D[終了]\n```")}</code></pre>
      </div>
      <div class="help-syntax">
        <div class="help-title">PlantUML（シーケンス図）</div>
        <pre class="code-block"><code>${escapeHtml("@startuml\nAlice -> Bob: こんにちは\nBob --> Alice: やあ\n@enduml")}</code></pre>
      </div>
    </div>`;

  openModal(`
    <h2>💡 使い方・Tips（Markdown）</h2>
    <p class="help-note">メッセージは Markdown 記法で装飾できます。左が入力、右が表示結果です。改行は <b>Shift+Enter</b>、送信は <b>Enter</b> です。</p>
    <div class="help-list">${rows}</div>
    ${diagramSection}
    <div class="modal-actions">
      <button class="btn-primary" id="help-close">閉じる</button>
    </div>
  `, true);
  $("#help-close").onclick = closeModal;
}

function modalCreateServer() {
  openModal(`
    <h2>サーバーを作成 / 参加</h2>
    <label>新しいサーバーを作成
      <input type="text" id="new-server-name" placeholder="例: 開発チーム" />
    </label>
    <div class="modal-actions" style="margin-bottom:8px;">
      <button class="btn-primary" id="create-server-confirm">作成</button>
    </div>
    <hr style="border-color:var(--divider);margin:16px 0;" />
    <label>招待コードで参加
      <input type="text" id="join-code" placeholder="例: ABCD2345" style="text-transform:uppercase;" />
    </label>
    <div id="invite-preview" style="color:var(--text-muted);font-size:13px;min-height:18px;margin-bottom:8px;"></div>
    <div class="modal-actions">
      <button class="btn-secondary" id="modal-cancel">閉じる</button>
      <button class="btn-primary" id="join-code-confirm">参加</button>
    </div>
  `);
  $("#modal-cancel").onclick = closeModal;
  $("#create-server-confirm").onclick = async () => {
    const name = $("#new-server-name").value.trim();
    if (!name) return;
    try {
      const server = await api("/api/servers", { method: "POST", body: JSON.stringify({ name }) });
      await loadServers();
      closeModal();
      await selectServer(server.id);
    } catch (err) { alert(err.message); }
  };

  // コード入力時にプレビュー表示
  const codeInput = $("#join-code");
  codeInput.addEventListener("blur", async () => {
    const code = codeInput.value.trim().toUpperCase();
    const prev = $("#invite-preview");
    if (!code) { prev.textContent = ""; return; }
    try {
      const info = await api(`/api/invites/${encodeURIComponent(code)}`);
      prev.textContent = info.already_member
        ? `「${info.server_name}」には既に参加しています`
        : `参加先: ${info.server_name}`;
      prev.style.color = "var(--green)";
    } catch (err) {
      prev.textContent = err.message;
      prev.style.color = "var(--red)";
    }
  });

  $("#join-code-confirm").onclick = async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (!code) return;
    try {
      const server = await api(`/api/invites/${encodeURIComponent(code)}/accept`, { method: "POST" });
      await loadServers();
      closeModal();
      await selectServer(server.id);
    } catch (err) { alert(err.message); }
  };
}

// ===== 招待コード発行・管理（管理者/モデレーター） =====
function modalInvite() {
  if (!state.currentServerId) return;
  const serverId = state.currentServerId;
  openModal(`
    <h2>メンバーを招待</h2>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">
      招待コードを発行し、参加してほしい相手に伝えてください。相手は「サーバーを追加」→「招待コードで参加」から参加できます。
    </p>
    <label>最大使用回数（空欄で無制限）
      <input type="number" id="inv-max" min="1" placeholder="無制限" />
    </label>
    <label>有効期限（分・空欄で無期限）
      <input type="number" id="inv-exp" min="1" placeholder="無期限" />
    </label>
    <div class="modal-actions" style="margin-bottom:8px;">
      <button class="btn-primary" id="gen-invite">招待コードを発行</button>
    </div>
    <div class="member-section-title">発行済みの招待</div>
    <div id="invite-list" class="user-pick"></div>
    <div class="modal-actions">
      <button class="btn-secondary" id="modal-cancel">閉じる</button>
    </div>
  `);
  $("#modal-cancel").onclick = closeModal;

  async function refreshList() {
    const invites = await api(`/api/servers/${serverId}/invites`);
    const div = $("#invite-list");
    div.innerHTML = "";
    const active = invites.filter((i) => !i.is_revoked);
    if (active.length === 0) {
      div.innerHTML = `<div class="empty-state" style="margin:8px 0;">有効な招待はありません</div>`;
      return;
    }
    active.forEach((inv) => {
      const usesLabel = inv.max_uses ? `${inv.uses}/${inv.max_uses}回` : `${inv.uses}回（無制限）`;
      const expLabel = inv.expires_at ? `期限: ${fmtTime(inv.expires_at)}` : "無期限";
      const item = document.createElement("div");
      item.className = "user-pick-item";
      item.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;color:var(--text-bright);letter-spacing:1px;">${escapeHtml(inv.code)}</div>
          <div style="font-size:11px;color:var(--text-muted);">${usesLabel} / ${expLabel}</div>
        </div>
        <button class="btn-secondary" data-act="copy">コピー</button>
        <button class="btn-secondary" data-act="revoke" style="color:var(--red);">無効化</button>`;
      item.querySelector('[data-act="copy"]').onclick = () => copyText(inv.code);
      item.querySelector('[data-act="revoke"]').onclick = async () => {
        await api(`/api/servers/${serverId}/invites/${inv.id}`, { method: "DELETE" });
        refreshList();
      };
      div.appendChild(item);
    });
  }

  $("#gen-invite").onclick = async () => {
    const maxUses = $("#inv-max").value ? parseInt($("#inv-max").value, 10) : null;
    const exp = $("#inv-exp").value ? parseInt($("#inv-exp").value, 10) : null;
    try {
      const inv = await api(`/api/servers/${serverId}/invites`, {
        method: "POST",
        body: JSON.stringify({ max_uses: maxUses, expires_in_minutes: exp }),
      });
      copyText(inv.code);
      await refreshList();
    } catch (err) { alert(err.message); }
  };

  refreshList();
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => alert(`招待コードをコピーしました: ${text}`),
      () => alert(`招待コード: ${text}`)
    );
  } else {
    alert(`招待コード: ${text}`);
  }
}

function modalCreateChannel() {
  if (!state.currentServerId) return;
  openModal(`
    <h2>チャンネルを作成</h2>
    <label>チャンネル名
      <input type="text" id="new-channel-name" placeholder="例: 雑談" />
    </label>
    <label>トピック（任意）
      <input type="text" id="new-channel-topic" placeholder="チャンネルの説明" />
    </label>
    <div class="modal-actions">
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>
      <button class="btn-primary" id="create-channel-confirm">作成</button>
    </div>
  `);
  $("#modal-cancel").onclick = closeModal;
  $("#create-channel-confirm").onclick = async () => {
    const name = $("#new-channel-name").value.trim();
    const topic = $("#new-channel-topic").value.trim();
    if (!name) return;
    try {
      const ch = await api(`/api/servers/${state.currentServerId}/channels`, {
        method: "POST", body: JSON.stringify({ name, topic, type: "text" }),
      });
      state.channels = await api(`/api/servers/${state.currentServerId}/channels`);
      closeModal();
      await selectChannel(ch.id);
    } catch (err) { alert(err.message); }
  };
}

function modalCreateDM() {
  const selected = new Set();
  openModal(`
    <h2>ダイレクトメッセージ</h2>
    <label>メンバーを選択</label>
    <div class="user-pick" id="dm-user-pick"></div>
    <div class="modal-actions">
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>
      <button class="btn-primary" id="create-dm-confirm">開始</button>
    </div>
  `);
  const pick = $("#dm-user-pick");
  state.users.filter((u) => u.id !== state.user.id).forEach((u) => {
    const item = document.createElement("div");
    item.className = "user-pick-item";
    item.innerHTML = `<div class="avatar">${avatarHtml(u)}</div><span>${escapeHtml(u.display_name)}</span>`;
    item.onclick = () => {
      if (selected.has(u.id)) { selected.delete(u.id); item.classList.remove("selected"); }
      else { selected.add(u.id); item.classList.add("selected"); }
    };
    pick.appendChild(item);
  });
  $("#modal-cancel").onclick = closeModal;
  $("#create-dm-confirm").onclick = async () => {
    if (selected.size === 0) return;
    try {
      const dm = await api("/api/dms", {
        method: "POST", body: JSON.stringify({ user_ids: [...selected] }),
      });
      await loadDMs();
      closeModal();
      showDMHome();
      await selectDM(dm.id);
    } catch (err) { alert(err.message); }
  };
}

function modalProfile() {
  const u = state.user;
  openModal(`
    <h2>プロフィール設定</h2>
    <label>表示名
      <input type="text" id="pf-name" value="${escapeHtml(u.display_name)}" />
    </label>
    <label>ステータスメッセージ
      <input type="text" id="pf-status" value="${escapeHtml(u.status_message || "")}" placeholder="例: 作業中" />
    </label>
    <label>アイコン画像URL（社内サーバー内のパス）
      <input type="text" id="pf-avatar" value="${escapeHtml(u.avatar_url || "")}" placeholder="/api/files/123?token=..." />
    </label>
    <div class="member-section-title">アクセストークン（図ラボ用）</div>
    <p class="member-role" style="margin:0 0 6px;">図エラー検証ラボ（PlantUML サーバー描画）の「アクセストークン」欄に貼り付けて使います。</p>
    <div style="display:flex;gap:8px;align-items:stretch;">
      <input type="password" id="pf-token" value="${escapeHtml(state.token || "")}" readonly style="flex:1;font-family:monospace;" />
      <button class="btn-secondary" id="pf-token-toggle" type="button" title="表示/非表示">表示</button>
      <button class="btn-secondary" id="pf-token-copy" type="button">コピー</button>
    </div>
    <div class="member-section-title">アカウントの切り替え</div>
    <div id="account-list" class="user-pick"></div>
    <div class="modal-actions" style="margin-bottom:8px;">
      <button class="btn-secondary" id="add-account-btn">別のアカウントを追加</button>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="logout-btn" style="color:var(--red);">このアカウントからログアウト</button>
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>
      <button class="btn-primary" id="save-profile">保存</button>
    </div>
  `);
  renderAccountList();
  $("#add-account-btn").onclick = () => { closeModal(); showAuthView(true); };
  $("#modal-cancel").onclick = closeModal;
  $("#logout-btn").onclick = () => { closeModal(); logout(); };
  const tokenInput = $("#pf-token");
  $("#pf-token-toggle").onclick = () => {
    const btn = $("#pf-token-toggle");
    if (tokenInput.type === "password") {
      tokenInput.type = "text";
      btn.textContent = "非表示";
    } else {
      tokenInput.type = "password";
      btn.textContent = "表示";
    }
  };
  $("#pf-token-copy").onclick = () => {
    const t = state.token || "";
    if (!t) { alert("トークンがありません"); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(
        () => alert("アクセストークンをコピーしました"),
        () => { tokenInput.type = "text"; tokenInput.select(); alert("コピーできませんでした。手動でコピーしてください。"); }
      );
    } else {
      tokenInput.type = "text";
      tokenInput.select();
      alert("コピーできませんでした。手動でコピーしてください。");
    }
  };
  $("#save-profile").onclick = async () => {
    try {
      const updated = await api("/api/users/me", {
        method: "PATCH",
        body: JSON.stringify({
          display_name: $("#pf-name").value.trim(),
          status_message: $("#pf-status").value.trim(),
          avatar_url: $("#pf-avatar").value.trim(),
        }),
      });
      state.user = updated;
      upsertAccount(state.token, updated);
      renderMyProfile();
      closeModal();
    } catch (err) { alert(err.message); }
  };
}

function renderAccountList() {
  const div = $("#account-list");
  if (!div) return;
  div.innerHTML = "";
  loadAccounts().forEach((acc) => {
    const isCurrent = acc.id === state.user.id;
    const item = document.createElement("div");
    item.className = "user-pick-item" + (isCurrent ? " selected" : "");
    item.innerHTML = `
      <div class="avatar">${acc.avatar_url ? `<img src="${escapeHtml(acc.avatar_url)}" alt="" />` : escapeHtml(initials(acc.display_name))}</div>
      <div style="flex:1;min-width:0;">
        <div class="member-name">${escapeHtml(acc.display_name)}</div>
        <div class="member-role">@${escapeHtml(acc.username)}</div>
      </div>
      ${isCurrent ? `<span class="member-role" style="color:var(--green);">使用中</span>` : `<button class="btn-secondary" data-act="switch">切り替え</button>`}`;
    const sw = item.querySelector('[data-act="switch"]');
    if (sw) sw.onclick = () => switchAccount(acc.token);
    div.appendChild(item);
  });
}

function openUserMenu(member) {
  // 自分が admin の場合のみロール変更・キック可能
  const me = state.members.find((m) => m.user.id === state.user.id);
  if (!me || me.role !== "admin" || member.user.id === state.user.id) return;
  // サーバーオーナーは操作不可
  const server = state.servers.find((s) => s.id === state.currentServerId);
  const isOwner = server && server.owner_id === member.user.id;
  openModal(`
    <h2>${escapeHtml(member.user.display_name)} のロール</h2>
    <label>ロール
      <select id="role-select">
        <option value="member" ${member.role === "member" ? "selected" : ""}>一般ユーザー</option>
        <option value="moderator" ${member.role === "moderator" ? "selected" : ""}>モデレーター</option>
        <option value="admin" ${member.role === "admin" ? "selected" : ""}>管理者</option>
      </select>
    </label>
    <div class="modal-actions">
      ${isOwner ? "" : `<button class="btn-danger" id="kick-member">キック</button>`}
      <button class="btn-secondary" id="modal-cancel">キャンセル</button>
      <button class="btn-primary" id="save-role">保存</button>
    </div>
  `);
  $("#modal-cancel").onclick = closeModal;
  $("#save-role").onclick = async () => {
    const role = $("#role-select").value;
    try {
      await api(`/api/servers/${state.currentServerId}/members/${member.user.id}/role`, {
        method: "PATCH", body: JSON.stringify({ role }),
      });
      state.members = await api(`/api/servers/${state.currentServerId}/members`);
      renderMembers();
      closeModal();
    } catch (err) { alert(err.message); }
  };
  const kickBtn = $("#kick-member");
  if (kickBtn) {
    kickBtn.onclick = async () => {
      if (!confirm(`${member.user.display_name} をサーバーから追放しますか？`)) return;
      try {
        await api(`/api/servers/${state.currentServerId}/members/${member.user.id}`, {
          method: "DELETE",
        });
        state.members = await api(`/api/servers/${state.currentServerId}/members`);
        renderMembers();
        closeModal();
      } catch (err) { alert(err.message); }
    };
  }
}

// ===== テーマ（ライト/ダーク切り替え） =====
const THEME_KEY = "lc_theme";

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    // ボタンには「切り替え先」を示すアイコンを表示
    btn.textContent = theme === "dark" ? "☀" : "🌙";
    btn.title = theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え";
  }
}

function initTheme() {
  let theme = localStorage.getItem(THEME_KEY);
  if (theme !== "dark" && theme !== "light") {
    // 初回はOSの設定に従う
    const prefersDark = window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    theme = prefersDark ? "dark" : "light";
  }
  applyTheme(theme);
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  // 以降に描画する Mermaid 図へテーマを反映（描画済みの図は再読込時に更新）
  if (window.mermaid) {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: next === "dark" ? "dark" : "default",
        securityLevel: "strict",
      });
    } catch (e) {}
  }
}

// Mermaid の初回描画は重い（レイアウトエンジン/フォントの遅延ロード）。
// ログイン直後のアイドル時間に小さな図を裏で描画して暖機し、
// 実際のチャンネル表示時の描画を高速化する。
let _mermaidWarmed = false;
function prewarmMermaid() {
  if (_mermaidWarmed || !window.mermaid) return;
  _mermaidWarmed = true;
  const run = async () => {
    try {
      await window.mermaid.render("mmd_prewarm_" + Date.now(), "graph TD\nA-->B");
    } catch (e) {}
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 1500 });
  } else {
    setTimeout(run, 200);
  }
}

// ===== チャンネルパネルの幅調整（ドラッグでリサイズ） =====
const CHANNEL_WIDTH_KEY = "lc_channel_width";
const CHANNEL_MIN = 180;
const CHANNEL_MAX = 500;

function setupResizer() {
  const resizer = $("#channel-resizer");
  const panel = document.querySelector(".channel-bar");
  if (!resizer || !panel) return;

  // 保存済みの幅を復元
  const saved = parseInt(localStorage.getItem(CHANNEL_WIDTH_KEY), 10);
  if (saved >= CHANNEL_MIN && saved <= CHANNEL_MAX) {
    panel.style.width = saved + "px";
  }

  let dragging = false;
  let startX = 0;
  let startW = 0;

  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    resizer.classList.add("dragging");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    let w = startW + (e.clientX - startX);
    w = Math.max(CHANNEL_MIN, Math.min(CHANNEL_MAX, w));
    panel.style.width = w + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    localStorage.setItem(CHANNEL_WIDTH_KEY, parseInt(panel.style.width, 10));
  });

  // ダブルクリックで既定幅に戻す
  resizer.addEventListener("dblclick", () => {
    panel.style.width = "240px";
    localStorage.setItem(CHANNEL_WIDTH_KEY, "240");
  });
}

// ===== イベント初期化 =====
function setupEvents() {
  // メッセージ入力
  const input = $("#message-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === "Escape" && state.editingId) {
      e.preventDefault();
      cancelEdit();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  });
  $("#send-btn").onclick = sendMessage;

  // 返信キャンセル
  $("#cancel-reply").onclick = () => {
    if (state.editingId) { cancelEdit(); }
    else { cancelReply(); }
  };

  // ファイル
  $("#upload-btn").onclick = () => $("#file-input").click();
  $("#file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) uploadFile(file);
    e.target.value = "";
  });

  // ドラッグ＆ドロップでファイル添付
  const chatArea = $(".chat-area");
  chatArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    chatArea.classList.add("drag-over");
  });
  chatArea.addEventListener("dragleave", (e) => {
    if (!chatArea.contains(e.relatedTarget)) {
      chatArea.classList.remove("drag-over");
    }
  });
  chatArea.addEventListener("drop", (e) => {
    e.preventDefault();
    chatArea.classList.remove("drag-over");
    const files = e.dataTransfer.files;
    for (const file of files) {
      uploadFile(file);
    }
  });

  // HTMLプレビューのソース表示切替（イベント委譲）
  chatArea.addEventListener("click", (e) => {
    const btn = e.target.closest(".html-preview-btn");
    if (!btn) return;
    const frameId = btn.dataset.frame;
    const sourceId = btn.dataset.source;
    const frame = document.getElementById(frameId);
    const source = document.getElementById(sourceId);
    if (!frame || !source) return;
    const showingSource = source.style.display !== "none";
    if (showingSource) {
      source.style.display = "none";
      frame.style.display = "block";
      btn.textContent = "</>";
      btn.title = "ソース表示";
    } else {
      source.style.display = "block";
      frame.style.display = "none";
      btn.textContent = "プレビュー";
      btn.title = "プレビュー表示";
    }
  });

  // クリップボードから画像ペースト（スクリーンショット等）
  $("#message-input").addEventListener("paste", (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          // ファイル名を生成（例: paste_20260615_143025.png）
          const now = new Date();
          const ts = now.getFullYear().toString()
            + String(now.getMonth() + 1).padStart(2, "0")
            + String(now.getDate()).padStart(2, "0")
            + "_"
            + String(now.getHours()).padStart(2, "0")
            + String(now.getMinutes()).padStart(2, "0")
            + String(now.getSeconds()).padStart(2, "0");
          const ext = item.type.split("/")[1] || "png";
          const file = new File([blob], `paste_${ts}.${ext}`, { type: item.type });
          uploadFile(file);
        }
        break;
      }
    }
  });

  // 絵文字
  $("#emoji-btn").onclick = toggleComposerEmoji;
  document.addEventListener("click", (e) => {
    const picker = $("#emoji-picker");
    if (picker.style.display !== "none" &&
        !picker.contains(e.target) &&
        !e.target.closest("#emoji-btn") &&
        !e.target.closest('[data-action="react"]')) {
      picker.style.display = "none";
    }
  });

  // ナビゲーション
  $("#dm-home").onclick = showDMHome;
  $("#add-server").onclick = modalCreateServer;
  $("#add-channel").onclick = modalCreateChannel;
  $("#add-dm").onclick = modalCreateDM;
  $("#open-profile").onclick = modalProfile;
  $("#open-invite").onclick = modalInvite;
  $("#theme-toggle").onclick = toggleTheme;
  $("#open-help").onclick = modalHelp;
  $("#toggle-members").onclick = () => {
    const bar = $("#member-bar");
    bar.style.display = (bar.style.display === "none" && state.view === "server") ? "block" : "none";
  };

  // モーダル背景クリックで閉じる
  $("#modal-overlay").addEventListener("click", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
}

// ===== 起動 =====
async function main() {
  initTheme();
  buildEmojiPicker();
  // Mermaid 初期化（オフライン同梱・厳格セキュリティで描画）
  if (window.mermaid) {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: currentTheme() === "dark" ? "dark" : "default",
        securityLevel: "strict",
      });
    } catch (e) {}
    prewarmMermaid();
  }
  setupAuth();
  setupEvents();
  setupResizer();
  await bootstrap();
}

// 保存済みアカウントを順に検証し、有効なもので起動する。
// 無効/期限切れのトークンは静かに除外し、どれも無効ならログイン画面を表示する。
async function bootstrap() {
  const accounts = loadAccounts();

  // 試行順: 現在のアクティブトークン → その他
  const ordered = [];
  const active = accounts.find((a) => a.token === state.token);
  if (active) ordered.push(active);
  for (const a of accounts) {
    if (!ordered.includes(a)) ordered.push(a);
  }
  // 旧形式（lc_token のみ）からの移行: アカウント一覧が空でもトークンがあれば試す
  if (ordered.length === 0 && state.token) {
    ordered.push({ id: null, token: state.token });
  }

  for (const acc of ordered) {
    setActiveToken(acc.token);
    let me;
    try {
      // 副作用なしでトークンを検証
      me = await api("/api/auth/me", { skipAuthRedirect: true });
    } catch (e) {
      // 無効/期限切れトークン → このアカウントを除外して次へ
      if (acc.id != null) removeAccount(acc.id);
      continue;
    }
    // 有効なトークンが見つかった
    state.user = me;
    try {
      await startApp();
    } catch (e) {
      console.error("起動処理でエラーが発生しました:", e);
    }
    return;
  }

  // 有効なアカウントが無い → ログイン画面
  localStorage.removeItem(ACTIVE_KEY);
  localStorage.removeItem("lc_token");
  state.token = null;
  state.user = null;
  $("#auth-view").style.display = "flex";
}

main();
