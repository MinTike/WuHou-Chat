/* WAF 控制台启动模块（从 waf.html 的内联脚本外置而来）
 *
 * ★ 为什么要外置：见 boot-admin.js —— 严格的 script-src 'self' 不允许内联脚本。
 */
import { mountWaf } from '/static/js/waf.js?v=20261006';

// 主题跟随站点设置，避免管理员在浅色主题下突然看到一个深色控制台
// 安卓端（WebView）禁用极光：动态渐变背景会导致界面持续闪烁
const _storedTheme = localStorage.getItem('wuhou.theme');
const _isAndroid = /WuhouChatAndroid/i.test(navigator.userAgent);
if (_isAndroid && _storedTheme === 'aurora') {
  localStorage.setItem('wuhou.theme', 'dark'); // 顺手把存储里的极光也降级，避免反复横跳
  document.documentElement.dataset.theme = 'dark';
} else {
  document.documentElement.dataset.theme = _storedTheme || 'dark';
}

mountWaf(document.getElementById('wafRoot'));