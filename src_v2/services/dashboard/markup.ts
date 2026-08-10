/**
 * Server-rendered markup for the control centre.
 *
 * The page has one job — configure providers and models — so it is a single
 * scrolling document rather than a navigable app. The two app-level actions
 * live in the top bar; logs are a section, not a destination.
 *
 * Element ids are the contract with app.ts; renaming one silently breaks a
 * handler. test/dashboard_snapshot.test.mjs pins the rendered output.
 */
export const DASHBOARD_MARKUP = `<main class="app">
<header class="topbar"><div class="brand"><div class="brand-logo-wrap"><img class="brand-logo" src="/assets/opencodex-logo-compact.png?v=3" alt="OpenCodex 标志"></div><div>OpenCodex<small>本地控制中心</small></div></div><div class="topbar-actions"><button id="language-toggle" class="button ghost" type="button">English</button><button id="restart-settings" class="button">重启 Codex</button><button id="reset-button" class="button danger">还原原生</button></div></header>
<section class="workspace">
<section class="panel"><div class="headline"><div><h1>服务商与模型</h1><p>填入 API Key 添加模型；重启 Codex 后才在 Desktop 的模型菜单里生效。</p></div></div><article class="card gateway-card"><div class="card-head"><h2>API Key 接入</h2><span class="pill">仅填写 API Key</span></div><p class="help">地址与模型名已预设。保存后加入下方待应用清单，不会自动重启 Codex。</p><div id="api-provider-list" class="provider-list"><div class="empty">正在读取接入模板…</div></div></article><article class="card enabled-panel"><div class="card-head"><div><h2>待应用模型</h2><p class="help">保存 Key 后模型先加入此处；可逐个测试或删除，重启 Codex 后才在 Desktop 生效。</p></div><button id="restart-button" class="button" disabled title="添加至少一个第三方模型后才可重启">↻ 重启 Codex（应用模型菜单）</button></div><div id="enabled-models" class="enabled-list"><div class="empty">正在读取待应用模型…</div></div></article></section>
<section class="panel"><div class="headline"><div><h1>日志</h1><p>网关与本机控制中心的运行记录；敏感凭据不会出现在这里。</p></div><button id="refresh-logs" class="button">刷新</button></div><article class="card gateway-card"><div id="log-list" class="log-list"><div class="empty">正在读取日志…</div></div></article></section>
</section></main>
<div id="provider-modal" class="modal"><form id="provider-form" class="modal-box"><h2 id="provider-modal-title">配置服务商</h2><p id="provider-modal-copy">预设地址与模型将自动使用。保存 Key 后模型会加入待应用清单，可在下方测试、保留或删除；重启 Codex 后才正式生效。</p><div class="form-grid"><label class="field wide">API Key<input id="provider-key" type="password" autocomplete="off" placeholder="保存后写入 macOS Keychain" required></label></div><div id="candidate-note" class="note hidden"></div><div class="modal-actions"><button type="button" id="close-modal" class="button">取消</button><button id="test-candidate" class="button primary" type="submit">保存并添加模型</button><button id="confirm-enable" class="button primary hidden" type="button">保存并添加模型</button></div></div><div id="toast" class="toast"></div>`;
