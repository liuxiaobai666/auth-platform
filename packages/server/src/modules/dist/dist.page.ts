/**
 * 分发页的服务端渲染。
 *
 * 刻意不引模板引擎、不挂外部资源：这个页面是给最终用户的门面，
 * 打不开比不好看严重得多。字体用系统栈而非 Google Fonts——国内直连它经常超时。
 *
 * 所有来自后台配置的文本都先转义再拼接，插进去的标签全是本文件自己控制的，
 * 从根上堵死 XSS，而不是依赖「管理员不会写脚本」这种假设。
 */

export interface DistPageData {
  slug: string;
  title: string;
  tagline: string | null;
  logoUrl: string | null;
  intro: string | null;
  purchaseUrl: string | null;
  support: { qq: string | null; wechat: string | null; email: string | null };
  requireLicense: boolean;
  latest: {
    version: string;
    size: number | null;
    publishedAt: Date | null;
    notes: string | null;
  } | null;
  changelog: Array<{ version: string; publishedAt: Date | null; notes: string | null }>;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 只允许 http(s)，挡掉 javascript: 这类伪协议。 */
function safeUrl(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? esc(trimmed) : null;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function formatDate(date: Date | null): string {
  if (!date) return '';
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 极简 markdown。先整体转义，之后再套格式，
 * 所以正文里就算写了 <script> 也只会原样显示成文字。
 */
function renderIntro(text: string | null): string {
  if (!text || !text.trim()) return '';
  const escaped = esc(text);
  const blocks = escaped.split(/\n{2,}/);

  return blocks
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return '';

      if (lines.every((l) => /^[-*]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) {
        const level = (lines[0].match(/^#+/) || ['#'])[0].length;
        const tag = level === 1 ? 'h2' : 'h3';
        return `<${tag}>${inline(lines[0].replace(/^#{1,3}\s+/, ''))}</${tag}>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('');
}

function inline(text: string): string {
  // 输入已转义，这里只是把标记替换成标签
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function renderDistPage(data: DistPageData): string {
  const logo = safeUrl(data.logoUrl);
  const purchase = safeUrl(data.purchaseUrl);
  const hasSupport = !!(data.support.qq || data.support.wechat || data.support.email);

  const downloadCard = data.latest
    ? `
      <div class="version">
        <span class="ver">v${esc(data.latest.version)}</span>
        ${data.latest.size ? `<span class="dot">·</span><span>${esc(formatSize(data.latest.size))}</span>` : ''}
        ${data.latest.publishedAt ? `<span class="dot">·</span><span>${esc(formatDate(data.latest.publishedAt))}</span>` : ''}
      </div>
      ${data.requireLicense
        ? `<form id="unlock" autocomplete="off">
             <input id="key" type="text" placeholder="输入卡密后下载" spellcheck="false" autocomplete="off">
             <button type="submit" id="btn">验证并下载</button>
           </form>
           <p class="hint" id="hint">需要有效卡密才能下载安装包</p>`
        : `<button id="btn" class="solo">下载 v${esc(data.latest.version)}</button>
           <p class="hint" id="hint"></p>`}
    `
    : `<p class="empty">暂无可下载的安装包</p>`;

  const changelog = data.changelog.length
    ? `<section class="block">
         <h2>更新日志</h2>
         <ol class="log">
           ${data.changelog
             .map(
               (r) => `<li>
                 <div class="log-head">
                   <span class="log-ver">v${esc(r.version)}</span>
                   <span class="log-date">${esc(formatDate(r.publishedAt))}</span>
                 </div>
                 ${r.notes ? `<div class="log-notes">${renderIntro(r.notes)}</div>` : ''}
               </li>`,
             )
             .join('')}
         </ol>
       </section>`
    : '';

  const support = hasSupport
    ? `<section class="block">
         <h2>需要帮助</h2>
         <dl class="support">
           ${data.support.qq ? `<div><dt>QQ</dt><dd>${esc(data.support.qq)}</dd></div>` : ''}
           ${data.support.wechat ? `<div><dt>微信</dt><dd>${esc(data.support.wechat)}</dd></div>` : ''}
           ${data.support.email ? `<div><dt>邮箱</dt><dd>${esc(data.support.email)}</dd></div>` : ''}
         </dl>
       </section>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(data.title)} — 下载</title>
<style>
:root{
  --bg:#f6f7f9; --card:#fff; --ink:#161d26; --soft:#5b6875; --faint:#8b98a5;
  --line:#e4e8ec; --accent:#3b5bdb; --accent-ink:#fff; --err:#c0392b; --ok:#1e7a46;
  --field:#fff;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e131a; --card:#161d26; --ink:#e8edf2; --soft:#9aa8b5; --faint:#6b7885;
    --line:#26303b; --accent:#5c7cfa; --accent-ink:#fff; --err:#e07b6f; --ok:#5cb98a;
    --field:#0f151c;
  }
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  line-height:1.6;-webkit-font-smoothing:antialiased;
}
.wrap{max-width:640px;margin:0 auto;padding:48px 20px 72px}
.hero{text-align:center;margin-bottom:28px}
.logo{width:72px;height:72px;border-radius:16px;object-fit:cover;margin-bottom:16px}
h1{font-size:1.75rem;margin:0 0 8px;letter-spacing:-.02em}
.tagline{color:var(--soft);margin:0;font-size:1rem}
.card{
  background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:28px 24px;text-align:center;margin-bottom:24px;
}
.version{display:flex;justify-content:center;gap:8px;color:var(--soft);font-size:.9rem;margin-bottom:18px;flex-wrap:wrap}
.ver{font-weight:600;color:var(--ink)}
.dot{color:var(--faint)}
form{display:flex;gap:10px;flex-wrap:wrap}
input{
  flex:1 1 220px;min-width:0;padding:12px 14px;font-size:.95rem;
  border:1px solid var(--line);border-radius:9px;background:var(--field);color:var(--ink);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;
}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{
  padding:12px 22px;font-size:.95rem;font-weight:600;cursor:pointer;
  border:none;border-radius:9px;background:var(--accent);color:var(--accent-ink);
  font-family:inherit;
}
button.solo{width:100%}
button:hover{filter:brightness(1.08)}
button:disabled{opacity:.6;cursor:default}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.hint{font-size:.85rem;color:var(--faint);margin:12px 0 0;min-height:1.2em}
.hint.err{color:var(--err)}
.hint.ok{color:var(--ok)}
.empty{color:var(--faint);margin:0}
.buy{display:inline-block;margin-top:14px;color:var(--accent);font-size:.9rem;text-decoration:none}
.buy:hover{text-decoration:underline}
.block{
  background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:22px 24px;margin-bottom:18px;
}
.block h2{font-size:1.05rem;margin:0 0 14px}
.block p{margin:0 0 12px}
.block ul{margin:0 0 12px;padding-left:20px}
.block h3{font-size:.98rem;margin:16px 0 8px}
.block code{
  background:var(--bg);padding:2px 6px;border-radius:4px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;
}
.log{list-style:none;margin:0;padding:0}
/* 必须限定直接子元素：更新说明里的 <li> 也在 .log 之下，
   用 .log li 会把它们一并加上分隔线和间距 */
.log>li{padding:12px 0;border-top:1px solid var(--line)}
.log>li:first-child{border-top:none;padding-top:0}
.log-head{display:flex;align-items:baseline;gap:10px}
.log-ver{font-weight:600}
.log-date{color:var(--faint);font-size:.85rem}
.log-notes{color:var(--soft);font-size:.92rem;margin-top:4px}
.log-notes p{margin:0 0 6px}
.log-notes ul{margin:4px 0 0;padding-left:18px}
.log-notes li{margin-bottom:2px}
.support{margin:0;display:flex;flex-direction:column;gap:10px}
.support div{display:flex;gap:14px}
.support dt{color:var(--faint);font-size:.88rem;min-width:44px}
.support dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92rem}
footer{text-align:center;color:var(--faint);font-size:.8rem;margin-top:32px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
    <h1>${esc(data.title)}</h1>
    ${data.tagline ? `<p class="tagline">${esc(data.tagline)}</p>` : ''}
  </div>

  <div class="card">
    ${downloadCard}
    ${purchase ? `<a class="buy" href="${purchase}" target="_blank" rel="noopener noreferrer">还没有卡密？点此获取 →</a>` : ''}
  </div>

  ${data.intro ? `<section class="block"><h2>使用说明</h2>${renderIntro(data.intro)}</section>` : ''}
  ${changelog}
  ${support}

  <footer>本页面由授权中心提供</footer>
</div>

<script>
(function(){
  var slug = ${JSON.stringify(data.slug)};
  var need = ${data.requireLicense ? 'true' : 'false'};
  var btn = document.getElementById('btn');
  var hint = document.getElementById('hint');
  var keyEl = document.getElementById('key');
  if (!btn) return;

  function say(msg, cls){ hint.textContent = msg; hint.className = 'hint' + (cls ? ' ' + cls : ''); }

  function go(){
    var key = keyEl ? keyEl.value.trim() : '';
    if (need && !key) { say('请输入卡密', 'err'); return; }
    btn.disabled = true;
    say('正在验证…');

    fetch('/api/v1/pub/dist/' + encodeURIComponent(slug) + '/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key })
    }).then(function(r){
      return r.json().then(function(d){ return { ok: r.ok, data: d }; });
    }).then(function(res){
      btn.disabled = false;
      if (!res.ok) { say(res.data.message || '验证失败', 'err'); return; }
      say('验证通过，开始下载', 'ok');
      window.location.href = '/api/v1/pub/dist/' + encodeURIComponent(slug)
        + '/download?t=' + encodeURIComponent(res.data.ticket);
    }).catch(function(){
      btn.disabled = false;
      say('网络异常，请稍后重试', 'err');
    });
  }

  var form = document.getElementById('unlock');
  if (form) { form.addEventListener('submit', function(e){ e.preventDefault(); go(); }); }
  else { btn.addEventListener('click', go); }
})();
</script>
</body>
</html>`;
}
