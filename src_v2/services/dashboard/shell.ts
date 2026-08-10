/**
 * Document skeleton. The exact newline layout here is what the golden file pins down.
 *
 * Extracted verbatim from the single dashboard.ts template; see
 * test/dashboard_snapshot.test.mjs for the byte-exact contract.
 */
import { DASHBOARD_CSS } from "./styles.js";
import { DASHBOARD_MARKUP } from "./markup.js";
import { DASHBOARD_SCRIPT } from "./app.js";

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCodex 控制中心</title>
<style>
${DASHBOARD_CSS}</style></head><body>
${DASHBOARD_MARKUP}
<script>
${DASHBOARD_SCRIPT}
</script></body></html>`;
}
