/**
 * 里府語詞典 —— Cloudflare Worker 反向代理
 *
 * 作用：把来自 GitHub Pages 的 /api/* 请求转发给 WorkBuddy 云服务。
 * 原理：CORS 只约束浏览器，服务器之间通信没有跨域限制。
 *       浏览器请求的是你 GitHub Pages 的同域名地址（不存在跨域），
 *       Worker 再以服务端身份去请求云服务。
 *
 * 部署步骤：
 *   1. 打开 https://dash.cloudflare.com/sign-up 注册（免费，不用绑卡）
 *   2. 左侧菜单 Workers & Pages → Create → Create Worker
 *   3. 名字随便填（例如 leavean-proxy）→ Deploy
 *   4. 点 Edit code，把本文件内容全部粘贴进去，覆盖原有的示例代码
 *   5. 右上角 Deploy 保存
 *   6. 复制你的 Worker 地址（形如 https://leavean-proxy.你的账号.workers.dev）
 *
 * 然后回到 index.html，把 PROXY_BASE 改成：
 *   const PROXY_BASE = 'https://leavean-proxy.你的账号.workers.dev';
 */

const UPSTREAM = 'https://ai-chat-page-61327.app.workbuddy.host';
const PUBLISHABLE_KEY = 'wbpk_lG2R7lJCGtNzLG1xTjyfI9_vrcnHEUPjrfXwyRzkH6IXtDj24Yr9hWZ';

// 只允许转发到云服务的这些路径，避免被当成公开代理滥用
const ALLOWED_PREFIXES = ['/.cloud/llm/', '/.cloud/database/'];

// 允许的页面来源（自己有别的域名可以往这里加；'*' 表示不限制）
const ALLOWED_ORIGINS = ['*'];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes('*')
    ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : 'null');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Wb-Webapp-Access-Key,Accept,Prefer,Range',
    'Access-Control-Expose-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // 预检请求直接放行
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 浏览器访问 Worker 根地址时给个提示，便于确认部署成功
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(
        '✅ Leavean 代理已部署成功。\n\n请把下面这行填进 index.html：\n\n' +
        "const PROXY_BASE = '" + url.origin + "';\n",
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(origin) } }
      );
    }

    // 取出真实路径：支持 /api/.cloud/... 与 /.cloud/... 两种写法
    let path = url.pathname;
    if (path.startsWith('/api/')) path = path.slice(4);
    if (!path.startsWith('/.cloud/')) path = '/.cloud' + (path.startsWith('/') ? path : '/' + path);

    if (!ALLOWED_PREFIXES.some(p => path.startsWith(p))) {
      return new Response(JSON.stringify({ error: { code: 'proxy_path_denied', message: '不允许的转发路径：' + path } }),
        { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
    }

    const target = UPSTREAM + path + url.search;

    const headers = new Headers();
    headers.set('x-wb-webapp-access-key', PUBLISHABLE_KEY);
    const ct = request.headers.get('Content-Type');
    if (ct) headers.set('Content-Type', ct);
    const ac = request.headers.get('Accept');
    if (ac) headers.set('Accept', ac);
    // 流式响应必须带上，否则网关可能缓冲
    headers.set('Accept-Encoding', 'identity');

    const init = { method: request.method, headers, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (e) {
      return new Response(JSON.stringify({ error: { code: 'proxy_upstream_unreachable', message: String(e) } }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
    }

    const respHeaders = new Headers(corsHeaders(origin));
    const upCT = upstream.headers.get('Content-Type');
    if (upCT) respHeaders.set('Content-Type', upCT);
    respHeaders.set('Cache-Control', 'no-store');

    // 直接把上游响应体（含 SSE 流）原样透传
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
