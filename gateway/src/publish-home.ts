/** 用户还没建工作台时 /p/<id>/ 显示的默认页：介绍接驳、工作台能做什么、怎么生成自己的 */

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light dark; --ink:#1d2421; --ink2:#5a645f; --bg:#f6f4ef; --card:#fff; --line:#e3dfd6; --pine:#2f6b52; --code:#efece4; }
@media (prefers-color-scheme: dark) {
  :root { --ink:#ecefe9; --ink2:#a7b0aa; --bg:#151917; --card:#1d2320; --line:#2c3430; --pine:#7cc4a2; --code:#252c28; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; }
main { max-width:760px; margin:0 auto; padding:48px 20px 64px; }
h1 { font-size:28px; margin:0 0 8px; }
h2 { font-size:19px; margin:36px 0 12px; }
p { margin:8px 0; }
.lead { color:var(--ink2); font-size:17px; }
.tag { display:inline-block; font-size:13px; color:var(--pine); border:1px solid var(--pine); border-radius:999px; padding:1px 10px; margin-bottom:14px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px 16px; }
.card b { display:block; margin-bottom:4px; }
.card span { color:var(--ink2); font-size:14px; }
ol { padding-left:22px; } li { margin:6px 0; }
code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13.5px; background:var(--code); border-radius:6px; }
code { padding:1px 5px; }
pre { padding:12px 14px; overflow-x:auto; white-space:pre-wrap; border:1px solid var(--line); }
.note { color:var(--ink2); font-size:14px; }
footer { margin-top:44px; color:var(--ink2); font-size:13px; }
`;

export function defaultWorkbenchPage(tenantId: string, tenantName?: string) {
  const who = escapeHtml(tenantName?.trim() || tenantId);
  const id = escapeHtml(tenantId);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${who} 的工作台 · 接驳</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="tag">接驳 · 工作台</div>
  <h1>${who} 还没有建自己的工作台</h1>
  <p class="lead">这里是 ${who} 的对外工作台地址。现在看到的是默认页；等 ${who} 生成了自己的工作台，这个地址会直接换成那个页面，链接不用变。</p>

  <h2>接驳是什么</h2>
  <p>接驳是一个用手机、网页就能指挥 AI Agent 干活的平台。每个人有一台云端工作区：在 iPhone 或浏览器里说一句话，Agent 就在你的工作区里读代码、写代码、跑命令、整理资料，做完把结果交回来。你不用守着电脑，也不用自己搭服务器。</p>

  <h2>工作台能放什么</h2>
  <p>工作台就是把工作区里的东西做成一个网页，任何人拿到链接都能打开。常见的做法：</p>
  <div class="grid">
    <div class="card"><b>项目总览</b><span>几个项目的进度、最近改动、待办，一页看完。</span></div>
    <div class="card"><b>数据看板</b><span>定时抓数据、算指标，配上图表和今日提示。</span></div>
    <div class="card"><b>方案展示</b><span>设计稿、3D 模型、报告和 PDF，发链接给别人看。</span></div>
    <div class="card"><b>小工具</b><span>计算器、查询页、表单，团队或家人都能用。</span></div>
  </div>
  <p class="note">样例：把「行情监控 · 装修方案 · 公司项目」三个子工作区做成一页总览，行情部分每天给出今日提示，装修部分点开就是 3D 方案，项目部分列出最近的改动。</p>

  <h2>怎么生成自己的工作台</h2>
  <ol>
    <li>在接驳（iPhone App 或网页）登录，打开工作区列表里的 <b>USER 工作区</b>（你的根目录，下面是各个子工作区）。工作台只能在这里创建，子工作区里的会话做不了。</li>
    <li>新开一个会话，直接告诉 Agent 你想要什么，比如：
      <pre>帮我做一个工作台：一页总览我的几个子工作区，列出每个项目最近的改动和待办。用 Python 标准库写，做好后公开成我的工作台。</pre>
    </li>
    <li>Agent 写好页面后会执行 <code>jiebo-publish start -- &lt;启动命令&gt;</code>，把它挂到这个地址：<code>/p/${id}/</code>。刷新本页就能看到。</li>
    <li>以后想改，继续在 USER 工作区的会话里说「把工作台改成……」。Agent 会先 <code>jiebo-publish stop</code> 再重新公开。</li>
  </ol>

  <h2>写工作台时要注意</h2>
  <ul>
    <li>程序必须监听平台给的 <code>HOST</code> 和 <code>PORT</code>（只在 127.0.0.1 上），页面挂在 <code>BASE_PATH</code>（就是 <code>/p/${id}</code>）下，页面里的资源用相对地址。Agent 都知道这些规则。</li>
    <li>工作台一直开着：没人访问也不会停，服务器或平台重启后会自动重新拉起。</li>
    <li>工作台是公开的，拿到链接的人都能打开。不要把密码、持仓、个人隐私这类内容放进页面。</li>
  </ul>

  <footer>接驳 · 每人一个工作台 · 地址 /p/${id}/</footer>
</main>
</body>
</html>`;
}

export function workbenchDownPage(tenantId: string, tenantName?: string) {
  const who = escapeHtml(tenantName?.trim() || tenantId);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${who} 的工作台正在启动 · 接驳</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <div class="tag">接驳 · 工作台</div>
  <h1>${who} 的工作台正在重新启动</h1>
  <p class="lead">平台会自动把它拉起来，这个页面每 15 秒自动刷新一次。如果一直打不开，请在 USER 工作区的会话里让 Agent 执行 <code>jiebo-publish status</code> 看看原因。</p>
</main>
</body>
</html>`;
}
