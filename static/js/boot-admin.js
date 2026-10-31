/* 管理后台启动模块（从 admin.html 的内联脚本外置而来）
 *
 * ★ 为什么要外置：为了启用严格的 script-src 'self'。
 *   CSP 的 script-src 不含 'unsafe-inline' 时，<script> 内联代码一律不执行，
 *   这块就静默失效（控制台只剩一片空白）。外置是唯一干净的做法。
 */
import { mountAdmin } from '/static/js/admin.js?v=20261006';

// 主题跟随站点设置（深/浅/极光），避免管理员在浅色主题下看到一个深色控制台
// 安卓端（WebView）禁用极光：动态渐变背景会导致界面持续闪烁
const _storedTheme = localStorage.getItem('wuhou.theme');
const _isAndroid = /WuhouChatAndroid/i.test(navigator.userAgent);
if (_isAndroid && _storedTheme === 'aurora') {
  localStorage.setItem('wuhou.theme', 'dark'); // 顺手把存储里的极光也降级，避免反复横跳
  document.documentElement.dataset.theme = 'dark';
} else {
  document.documentElement.dataset.theme = _storedTheme || 'dark';
}
document.getElementById('copyright').textContent = 'Copyright © 2026 左熙宇 · 武侯Chat · 保留所有权利';

mountAdmin(document.getElementById('adminPage')).then((ok) => {
  document.getElementById('adminState').textContent = ok ? '已登录' : '需要管理员令牌';
  document.getElementById('adminState').className = 'admin-topbar__state ' + (ok ? 'is-ok' : 'is-warn');
});