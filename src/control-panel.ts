/**
 * A local control panel so you never have to open a file or the terminal.
 *
 *   npm run panel        -> http://127.0.0.1:7777
 *
 * It renders every config variable as a labelled field (from config-meta.ts, the same source
 * the offline editor uses), Save writes qa.config.json for you - after validating it against
 * the real schema, so a bad value is refused with a message instead of written - and the Run
 * buttons start the crawler and the other steps and stream their output live.
 *
 * Deliberately local and locked down: it binds to 127.0.0.1 only, it runs ONLY the fixed set
 * of npm scripts below (never anything typed in), and it never shows or edits passwords -
 * login and persona credentials in qa.config.json are passed through untouched. It writes one
 * file (qa.config.json) and spawns known scripts; treat it as the GUI for commands you would
 * otherwise type yourself, and run it only on a machine you trust.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, OUT, CONFIG_PATH, loadConfig } from "./config.js";
import { FIELDS, GROUPS, type FieldMeta } from "./config-meta.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PANEL_PORT) || 7777;

// The only things a button may start. No value from the page ever becomes a command.
const TASKS: Record<string, { argv: string[]; label: string; note: string; danger?: boolean }> = {
  preflight: { argv: ["run", "preflight"], label: "Preflight", note: "Is the target up, assets included?" },
  crawl: { argv: ["run", "crawl"], label: "Crawl (anon)", note: "Inventory the site → output/pages.jsonl" },
  "crawl:auth": { argv: ["run", "crawl:auth"], label: "Crawl (logged in)", note: "Needs a saved session" },
  profile: { argv: ["run", "profile"], label: "Tech profile", note: "Server, framework, headers, cookies" },
  coverage: { argv: ["run", "coverage"], label: "Coverage", note: "What nothing tests yet" },
  summary: { argv: ["run", "summary"], label: "Summary + nuclei plan", note: "output/summary.md" },
  report: { argv: ["run", "report"], label: "Build report", note: "output/report.html" },
  qa: { argv: ["run", "qa"], label: "Run everything (qa)", note: "crawl → tests → scans → report", danger: true },
};

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

// The MCP tools Claude uses - shown so you can see what the agent reaches for, and whether
// each server is wired up. The crawler and scanners do NOT use MCP: they drive Playwright and
// fetch directly. MCP is for the exploration phase, where Claude drives a browser and reads a
// test mailbox. Descriptions are read from the code; connection is checked at request time.
interface McpServer {
  name: string;
  what: string;
  command: string;
  tools: Array<{ name: string; what: string }>;
}
function mcpCatalog(): McpServer[] {
  let servers: Record<string, { command?: string; args?: string[] }> = {};
  try {
    servers = (JSON.parse(readFileSync(resolve(ROOT, ".mcp.json"), "utf8")).mcpServers ?? {}) as typeof servers;
  } catch {
    /* no .mcp.json */
  }
  const cmd = (k: string): string => {
    const s = servers[k];
    return s ? [s.command, ...(s.args ?? [])].join(" ") : "not registered in .mcp.json";
  };
  return [
    {
      name: "playwright",
      what: "A real Chromium that Claude drives during exploration: open a page, read its accessibility tree, click, type, read the console and network. This is how Phase 5 reaches features the script-only crawler cannot.",
      command: cmd("playwright"),
      tools: [
        { name: "browser_navigate", what: "Go to an in-scope URL" },
        { name: "browser_snapshot", what: "Read the page as an accessibility tree (preferred over screenshots)" },
        { name: "browser_click / browser_type", what: "Operate a control or fill a field" },
        { name: "browser_console_messages / browser_network_requests", what: "Read errors and traffic for a finding" },
      ],
    },
    {
      name: "email",
      what: "A read-only view of a disposable test inbox, so Claude can complete a signup or password-reset flow end to end. Receives mail only; it never sends.",
      command: cmd("email"),
      tools: [
        { name: "create_test_inbox", what: "Mint a throwaway address for this run" },
        { name: "get_verification_code", what: "Pull the code out of the latest matching email" },
        { name: "get_verification_link", what: "Pull the confirmation link (checked against allowedOrigins before use)" },
        { name: "read_latest_email", what: "Read the most recent message to the test address" },
      ],
    },
  ];
}

/** The allow-list of task ids a Run button may start. Exported so a test can assert it. */
export const TASK_IDS = Object.keys(TASKS);

function currentConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function fieldValue(cfg: Record<string, unknown>, f: FieldMeta): unknown {
  const v = cfg[f.key];
  return v === undefined ? f.default : v;
}

function renderField(cfg: Record<string, unknown>, f: FieldMeta): string {
  const v = fieldValue(cfg, f);
  const id = `f_${f.key}`;
  const flag = f.sensitive ? '<span class="flag" title="Changing this can have real-world effect">!</span>' : "";
  let control: string;
  if (f.type === "boolean") {
    control = `<label class="switch"><input type="checkbox" id="${id}" data-key="${esc(f.key)}" data-type="boolean" ${v ? "checked" : ""}><span>on</span></label>`;
  } else if (f.type === "stringList") {
    const text = Array.isArray(v) ? v.join("\n") : "";
    control = `<textarea id="${id}" data-key="${esc(f.key)}" data-type="stringList" rows="3" placeholder="${esc(f.placeholder ?? "one per line")}">${esc(text)}</textarea>`;
  } else if (f.type === "number") {
    control = `<input type="number" id="${id}" data-key="${esc(f.key)}" data-type="number" value="${v === undefined ? "" : esc(v)}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} placeholder="${esc(f.placeholder ?? "")}">`;
  } else {
    control = `<input type="text" id="${id}" data-key="${esc(f.key)}" data-type="string" value="${esc(v ?? "")}" placeholder="${esc(f.placeholder ?? "")}">`;
  }
  return `<div class="field${f.sensitive ? " sensitive" : ""}">
    <label for="${id}">${esc(f.label)}${flag} <code>${esc(f.key)}</code></label>
    <div class="help">${esc(f.help)}</div>
    ${control}
  </div>`;
}

export function page(): string {
  const cfg = currentConfig();
  const groups = GROUPS.map((g) => {
    const fields = FIELDS.filter((f) => f.group === g);
    if (!fields.length) return "";
    return `<details class="group" ${g === "Target" ? "open" : ""}><summary>${esc(g)} <span class="n">${fields.length}</span></summary>
      ${fields.map((f) => renderField(cfg, f)).join("")}</details>`;
  }).join("");
  const buttons = Object.entries(TASKS)
    .map(([id, t]) => `<button class="run${t.danger ? " danger" : ""}" data-task="${esc(id)}" title="${esc(t.note)}">${esc(t.label)}</button>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>QA Agent — control panel</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--ink:#e8eaed;--muted:#9aa1ad;--line:#272b34;--accent:#6ea8fe;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--code:#1d2733}
@media(prefers-color-scheme:light){:root{--bg:#f5f6f8;--panel:#fff;--ink:#16181d;--muted:#5b6472;--line:#e3e6ea;--accent:#2457d6;--ok:#15803d;--bad:#b91c1c;--warn:#b45309;--code:#eef1f5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap;position:sticky;top:0;background:var(--bg);z-index:5}
header h1{font-size:16px;margin:0}header .target{color:var(--muted);font:12px ui-monospace,monospace;overflow-wrap:anywhere}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0;min-height:calc(100vh - 58px)}
@media(max-width:860px){.wrap{grid-template-columns:1fr}}
.col{padding:18px 20px;min-width:0}.col.left{border-right:1px solid var(--line)}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
.group{border:1px solid var(--line);border-radius:10px;margin-bottom:10px;background:var(--panel)}
.group>summary{cursor:pointer;padding:10px 14px;font-weight:600;list-style:none;display:flex;justify-content:space-between;align-items:center}
.group>summary .n{color:var(--muted);font-weight:400;font-size:12px}
.group[open]>summary{border-bottom:1px solid var(--line)}
.field{padding:10px 14px;border-bottom:1px solid var(--line)}.field:last-child{border-bottom:0}
.field label{display:block;font-weight:600;margin-bottom:2px}.field label code{font-weight:400;color:var(--muted);font-size:11px}
.field .help{color:var(--muted);font-size:12px;margin-bottom:6px}
.field.sensitive{background:color-mix(in srgb,var(--warn) 7%,transparent)}
.flag{display:inline-block;width:15px;height:15px;line-height:15px;text-align:center;border-radius:50%;background:var(--warn);color:#000;font-size:11px;font-weight:700}
input[type=text],input[type=number],textarea{width:100%;font:inherit;font-size:13px;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}
textarea{font-family:ui-monospace,monospace;resize:vertical}
.switch{display:inline-flex;gap:8px;align-items:center;cursor:pointer}
.bar{display:flex;gap:10px;align-items:center;margin:4px 0 16px;flex-wrap:wrap}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:8px 13px}
button:hover{border-color:var(--accent)}button:disabled{opacity:.5;cursor:default}
#save{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.runs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
button.run.danger{border-color:var(--warn)}
.status{font-size:13px;min-height:18px;color:var(--muted)}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}
#out{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px;height:52vh;overflow:auto;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
#out .err{color:var(--bad)}#out .done{color:var(--ok)}#out .meta{color:var(--muted)}
.links a{color:var(--accent);margin-right:14px;font-size:13px}
.switch.watch{margin:8px 0 2px;font-size:13px;color:var(--muted)}
.tablewrap{overflow:auto;max-height:36vh;border:1px solid var(--line);border-radius:10px;margin-top:6px}
table{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,monospace}
#liveTable th{position:sticky;top:0;background:var(--panel);text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);color:var(--muted);font-weight:600}
#liveTable td{padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
#liveTable td.u{white-space:normal;word-break:break-all;color:var(--muted)}
#liveTable tr.bad td{color:var(--bad)}
.n{color:var(--muted);font-weight:400;font-size:12px}
.mcp .mcpbody{padding:10px 14px;border-top:1px solid var(--line)}
.mcpwhat{font-size:13px;margin-bottom:6px}.mcpcmd{font-size:11px;color:var(--muted);margin-bottom:8px;overflow-wrap:anywhere}
.mcptool{font-size:12.5px;padding:3px 0}.mcptool b{font-family:ui-monospace,monospace}
</style></head><body>
<header><h1>QA Agent</h1><span class="target" id="target">${esc(cfg.baseUrl ?? "no baseUrl set")}</span></header>
<div class="wrap">
  <div class="col left">
    <h2>Settings</h2>
    <div class="bar"><button id="save">Save settings</button><span class="status" id="saveStatus"></span></div>
    <form id="form">${groups}</form>
    <div class="bar"><button id="save2">Save settings</button></div>
  </div>
  <div class="col right">
    <h2>Run</h2>
    <div class="runs">${buttons}<button id="stop" disabled>Stop</button></div>
    <label class="switch watch"><input type="checkbox" id="headful"><span>Watch the browser window while it crawls</span></label>
    <div class="status" id="runStatus">Idle. Save your settings, then run Preflight or Crawl.</div>
    <div class="links" style="margin:8px 0 12px">
      <a href="/open/report" target="_blank">Open report.html</a>
      <a href="/open/summary" target="_blank">Open summary.md</a>
    </div>
    <div id="out" aria-live="polite"></div>

    <h2 style="margin-top:22px">Live crawl <span class="n" id="liveCount">0 pages</span></h2>
    <div class="status" id="liveNote">Fills as pages are inventoried. Rows flagged red are errors or deny-listed controls.</div>
    <div class="tablewrap"><table id="liveTable"><thead><tr><th>#</th><th>status</th><th>ms</th><th>forms</th><th>btn</th><th>denied</th><th>URL</th></tr></thead><tbody></tbody></table></div>

    <h2 style="margin-top:22px">MCP tools <span class="n">what Claude drives in exploration</span></h2>
    <div class="status">The crawler and scanners use Playwright and HTTP directly — not MCP. These are the tools Claude reaches for in Phase 5.</div>
    ${mcpCatalog()
      .map(
        (s) => `<details class="group mcp"><summary>${esc(s.name)} <span class="n">${s.tools.length} tools</span></summary>
      <div class="mcpbody">
        <div class="mcpwhat">${esc(s.what)}</div>
        <div class="mcpcmd"><code>${esc(s.command)}</code></div>
        ${s.tools.map((t) => `<div class="mcptool"><b>${esc(t.name)}</b> — ${esc(t.what)}</div>`).join("")}
      </div></details>`,
      )
      .join("")}
  </div>
</div>
<script>
const $=s=>document.querySelector(s);
function collect(){const o={};document.querySelectorAll('[data-key]').forEach(el=>{
  const k=el.dataset.key,t=el.dataset.type;
  if(t==='boolean')o[k]=el.checked;
  else if(t==='stringList')o[k]=el.value.split('\\n').map(x=>x.trim()).filter(Boolean);
  else if(t==='number'){if(el.value==='')return;o[k]=Number(el.value);}
  else{if(el.value==='')return;o[k]=el.value;}
});return o;}
async function save(){
  const st=$('#saveStatus');st.textContent='Saving…';st.className='status';
  try{const r=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(collect())});
    const j=await r.json();
    if(j.ok){st.textContent='Saved ✓';st.className='status ok';$('#target').textContent=j.baseUrl||'';}
    else{st.textContent='Not saved: '+j.error;st.className='status bad';}
  }catch(e){st.textContent='Error: '+e.message;st.className='status bad';}
}
$('#save').onclick=save;$('#save2').onclick=save;
let es=null;
function setRunning(on){document.querySelectorAll('button.run').forEach(b=>b.disabled=on);$('#stop').disabled=!on;}
function line(text,cls){const d=document.createElement('div');if(cls)d.className=cls;d.textContent=text;$('#out').appendChild(d);$('#out').scrollTop=$('#out').scrollHeight;}
document.querySelectorAll('button.run').forEach(b=>b.onclick=()=>{
  if(es)es.close();
  $('#out').innerHTML='';const task=b.dataset.task;
  $('#runStatus').textContent='Running '+task+'…';$('#runStatus').className='status';setRunning(true);
  line('$ npm run '+task,'meta');
  const hf=$('#headful').checked?'&headful=1':'';
  es=new EventSource('/run?task='+encodeURIComponent(task)+hf);
  es.addEventListener('out',e=>line(e.data));
  es.addEventListener('err',e=>line(e.data,'err'));
  es.addEventListener('done',e=>{const code=JSON.parse(e.data).code;line('— finished, exit '+code,'done');
    $('#runStatus').textContent=code===0?('Done: '+task):(task+' exited '+code);$('#runStatus').className='status '+(code===0?'ok':'bad');
    setRunning(false);es.close();es=null;});
  es.onerror=()=>{line('— stream closed','meta');$('#runStatus').className='status bad';setRunning(false);if(es){es.close();es=null;}};
});
$('#stop').onclick=()=>{fetch('/stop',{method:'POST'});};
// Live crawl table: tails output/pages.jsonl and appends a row per page as it lands.
(function live(){
  let n=0;const body=$('#liveTable tbody');
  const ls=new EventSource('/live');
  ls.addEventListener('page',e=>{
    const p=JSON.parse(e.data);n++;
    const denied=(p.deniedButtons||0)+(p.deniedLinks||0);
    const tr=document.createElement('tr');
    const bad=p.ok===false||(p.status||0)>=400||p.pageErrors;
    if(bad)tr.className='bad';
    tr.innerHTML='<td>'+n+'</td><td>'+(p.status==null?'ERR':p.status)+'</td><td>'+(p.loadMs??'')+'</td><td>'+(p.forms||0)+'</td><td>'+(p.buttons||0)+'</td><td>'+denied+'</td>';
    const u=document.createElement('td');u.className='u';u.textContent=p.url||'';tr.appendChild(u);
    body.appendChild(tr);$('#liveCount').textContent=n+' pages';
    tr.scrollIntoView({block:'nearest'});
  });
  ls.addEventListener('reset',()=>{n=0;body.innerHTML='';$('#liveCount').textContent='0 pages';});
  ls.onerror=()=>{/* keep trying; EventSource auto-reconnects */};
})();
</script></body></html>`;
}

// --- server ---------------------------------------------------------------

let running: ReturnType<typeof spawn> | null = null;

/**
 * Is this request safe to act on, or is it a web page the user is merely browsing reaching
 * into the panel?
 *
 * The panel binds to 127.0.0.1, but that does not stop a page on the open web from POSTing
 * to http://127.0.0.1:PORT/save or opening an EventSource to /run - a DNS-rebinding/CSRF
 * reach into a localhost service. Two cheap header checks shut that door without breaking
 * the panel's own fetch()/EventSource:
 *   - the Host header must name THIS loopback origin. A rebinding attacker that points
 *     evil.com at 127.0.0.1 still sends `Host: evil.com`, which fails here.
 *   - for the side-effecting routes (checkOrigin), any Origin/Referer that is present must
 *     be our own origin. A same-origin fetch sends a matching Origin (a same-origin
 *     navigation sends none); a cross-site attacker page sends its own, which fails.
 */
type HeaderVal = string | string[] | undefined;
export function isLocalRequest(
  headers: { host?: HeaderVal; origin?: HeaderVal; referer?: HeaderVal },
  port: number,
  opts: { checkOrigin?: boolean } = {},
): boolean {
  // A header can arrive as an array; take the first value, which is what a browser sends.
  const one = (v: HeaderVal): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "");
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(one(headers.host).toLowerCase())) return false;
  if (opts.checkOrigin) {
    const origins = hosts.map((h) => `http://${h}`);
    // Absent is fine (a same-origin navigation); present-and-foreign is the attack.
    const origin = one(headers.origin);
    if (origin && !origins.includes(origin)) return false;
    const referer = one(headers.referer);
    if (referer) {
      let ro: string;
      try {
        ro = new URL(referer).origin;
      } catch {
        return false; // a Referer we cannot parse on a state-changing route: refuse it
      }
      if (!origins.includes(ro)) return false;
    }
  }
  return true;
}

function send(res: ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1_000_000) req.destroy(); // a config is small; cap it
    });
    req.on("end", () => resolveBody(b));
  });
}

/** Turn a Zod validation failure into one short, field-named line a non-expert can act on. */
function describeConfigError(e: unknown): string {
  const issues = (e as { issues?: Array<{ path?: Array<string | number>; message?: string }> })?.issues;
  if (Array.isArray(issues) && issues.length) {
    return issues
      .slice(0, 3)
      .map((i) => `${(i.path ?? []).join(".") || "config"}: ${i.message ?? "invalid"}`)
      .join("; ")
      .slice(0, 300);
  }
  return (e as Error)?.message?.split("\n")[0]?.slice(0, 300) || "invalid config";
}

export function saveConfig(bodyJson: string): { ok: true; baseUrl: string } | { ok: false; error: string } {
  let edits: Record<string, unknown>;
  try {
    edits = JSON.parse(bodyJson);
  } catch {
    return { ok: false, error: "the form sent invalid JSON" };
  }
  // Start from the file so login/personas and any key the form does not show are preserved.
  const merged = currentConfig();
  const known = new Set(FIELDS.map((f) => f.key));
  for (const [k, v] of Object.entries(edits)) if (known.has(k)) merged[k] = v;
  const text = JSON.stringify(merged, null, 2) + "\n";
  // Validate against the real strict schema by loading from a file; never write a config the
  // pipeline would then reject. The merged config carries login/persona passwords, so this
  // copy goes under OUT (project-local and gitignored, not a world-readable os.tmpdir()),
  // with a fixed name and 0o600, and is ALWAYS removed in the finally - earlier it was left
  // in tmpdir for anyone on the box to read.
  const tmp = resolve(OUT, ".qa-config.validate.json");
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(tmp, text, { mode: 0o600 });
    loadConfig(tmp);
  } catch (e) {
    return { ok: false, error: describeConfigError(e) };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Never written, or already gone: nothing to clean up.
    }
  }
  writeFileSync(CONFIG_PATH, text);
  return { ok: true, baseUrl: String(merged.baseUrl ?? "") };
}

function runTask(task: string, headful: boolean, res: ServerResponse): void {
  const t = TASKS[task];
  if (!t) {
    send(res, 400, "text/plain", "unknown task");
    return;
  }
  if (running) {
    send(res, 409, "text/plain", "a task is already running");
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const event = (name: string, data: string): void => {
    for (const ln of data.split(/\r?\n/)) res.write(`event: ${name}\ndata: ${ln}\n\n`);
  };
  // Watch mode only makes sense for the crawl steps; the crawler reads QA_HEADFUL.
  const wantsHeadful = headful && (task === "crawl" || task === "crawl:auth");
  const env = wantsHeadful ? { ...process.env, QA_HEADFUL: "1" } : process.env;
  const child = spawn("npm", t.argv, { cwd: ROOT, shell: process.platform === "win32", env });
  running = child;
  child.stdout.on("data", (d) => event("out", d.toString()));
  child.stderr.on("data", (d) => event("err", d.toString()));
  child.on("close", (code) => {
    running = null;
    res.write(`event: done\ndata: ${JSON.stringify({ code: code ?? -1 })}\n\n`);
    res.end();
  });
  child.on("error", (e) => {
    running = null;
    event("err", `could not start: ${e.message}`);
    res.write(`event: done\ndata: ${JSON.stringify({ code: -1 })}\n\n`);
    res.end();
  });
  res.on("close", () => {
    // The browser went away; leave the task running or stop it? Stop, to avoid orphans.
    if (running === child && !child.killed) child.kill();
  });
}

interface LivePage {
  url?: string;
  status?: number | null;
  loadMs?: number;
  ok?: boolean;
  forms?: unknown[];
  buttons?: unknown[];
  deniedButtons?: unknown[];
  deniedLinks?: unknown[];
  pageErrors?: unknown[];
}
/** The pages files the live table tails, resolved under OUT so QA_OUT is honoured. */
export function livePagesFiles(): string[] {
  return ["pages.jsonl", "pages.auth.jsonl"].map((f) => resolve(OUT, f));
}

/** The file an /open/<which> link serves, resolved under OUT. Null for an unknown name. */
export function openTargetPath(which: string): { file: string; path: string } | null {
  const file = which === "report" ? "report.html" : which === "summary" ? "summary.md" : "";
  if (!file) return null;
  return { file, path: resolve(OUT, file) };
}

/** Tail OUT/pages*.jsonl and push one slim row per page as the crawler writes it. */
function liveStream(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write("event: reset\ndata: {}\n\n");
  const files = livePagesFiles();
  const offset = new Map<string, number>(files.map((f) => [f, 0]));
  let closed = false;
  const tick = (): void => {
    if (closed) return;
    for (const f of files) {
      let size = 0;
      try {
        size = statSync(f).size;
      } catch {
        continue; // not created yet
      }
      const from = offset.get(f) ?? 0;
      if (size < from) {
        offset.set(f, 0); // file was truncated/rotated
        res.write("event: reset\ndata: {}\n\n");
        continue;
      }
      if (size > from) {
        let text = "";
        try {
          text = readFileSync(f, "utf8").slice(from);
        } catch {
          continue;
        }
        offset.set(f, size);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const p = JSON.parse(line) as LivePage;
            const slim = {
              url: p.url,
              status: p.status ?? null,
              loadMs: p.loadMs,
              ok: p.ok,
              forms: p.forms?.length ?? 0,
              buttons: p.buttons?.length ?? 0,
              deniedButtons: p.deniedButtons?.length ?? 0,
              deniedLinks: p.deniedLinks?.length ?? 0,
              pageErrors: (p.pageErrors?.length ?? 0) > 0,
            };
            res.write(`event: page\ndata: ${JSON.stringify(slim)}\n\n`);
          } catch {
            /* a half-written last line; next tick picks it up */
          }
        }
      }
    }
    setTimeout(tick, 600);
  };
  tick();
  res.on("close", () => {
    closed = true;
  });
}

const server = createServer(async (req, res) => {
  // Every request must be addressed to this loopback origin. This is the interlock that
  // keeps a page the user is browsing from reaching the panel at all.
  if (!isLocalRequest(req.headers, PORT)) return send(res, 403, "text/plain", "forbidden");
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", page());
  if (req.method === "POST" && url.pathname === "/save") {
    // A state-changing route: also refuse a cross-site Origin/Referer before saveConfig runs.
    if (!isLocalRequest(req.headers, PORT, { checkOrigin: true })) return send(res, 403, "text/plain", "forbidden");
    const result = saveConfig(await readBody(req));
    return send(res, 200, "application/json", JSON.stringify(result));
  }
  if (req.method === "GET" && url.pathname === "/run") {
    if (!isLocalRequest(req.headers, PORT, { checkOrigin: true })) return send(res, 403, "text/plain", "forbidden");
    return runTask(url.searchParams.get("task") ?? "", url.searchParams.get("headful") === "1", res);
  }
  if (req.method === "GET" && url.pathname === "/live") return liveStream(res);
  if (req.method === "POST" && url.pathname === "/stop") {
    if (!isLocalRequest(req.headers, PORT, { checkOrigin: true })) return send(res, 403, "text/plain", "forbidden");
    if (running && !running.killed) running.kill();
    return send(res, 200, "application/json", JSON.stringify({ stopped: true }));
  }
  if (req.method === "GET" && url.pathname.startsWith("/open/")) {
    const target = openTargetPath(url.pathname.slice("/open/".length));
    if (!target) return send(res, 404, "text/plain", "not found");
    try {
      const type = target.file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
      return send(res, 200, type, readFileSync(target.path, "utf8"));
    } catch {
      return send(res, 404, "text/plain", `${target.file} not built yet — run the matching button first`);
    }
  }
  send(res, 404, "text/plain", "not found");
});

// Start the server only when run directly, so tests can import the pure helpers above
// without opening a socket or spawning anything.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("control-panel.ts")) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  QA Agent control panel → http://${HOST}:${PORT}\n  (local only; Ctrl+C to stop)\n`);
  });
}
