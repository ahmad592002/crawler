/**
 * Generate output/config.html: a local, offline editor for every config variable.
 *
 * Why a generated LOCAL page and not a hosted one: the config carries login credentials and
 * the output is the project's own qa.config.json, so CLAUDE.md's rule that session material
 * never leaves the machine makes a local file the only honest choice. It opens with a
 * double-click, needs no server, and the current config is baked in as the starting state -
 * so "edit the config" is a form with help text, not a hunt through a JSON file.
 *
 * The page cannot write back to disk (a browser cannot), so it exports: Download writes a
 * fresh qa.config.json to drop into the project, Copy puts it on the clipboard. The data and
 * the renderer are both embedded, so the file works with no network at all.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, OUT, CONFIG_PATH } from "./config.js";
import { FIELDS, GROUPS } from "./config-meta.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildConfigPage(): string {
  // loadConfig applies defaults, so the editor opens on the EFFECTIVE config - what the
  // tool actually runs with, not just what happens to be written in the file.
  const cfg = loadConfig() as Record<string, unknown>;

  const payload = {
    fields: FIELDS,
    groups: GROUPS,
    values: cfg,
    sourcePath: CONFIG_PATH,
  };

  // The data goes in via a JSON script tag, not string interpolation into JS, so a value
  // containing </script> or a quote cannot break the page or inject anything.
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA config editor</title>
<style>
:root{--bg:#f7f7f8;--panel:#fff;--ink:#16181d;--muted:#6b7280;--line:#e4e4e7;
--accent:#4338ca;--warn:#b45309;--ok:#15803d;--bad:#b91c1c;--code:#f3f4f6;}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e8eaed;--muted:#9aa1ad;
--line:#272b34;--accent:#a5b4fc;--warn:#fbbf24;--ok:#4ade80;--bad:#f87171;--code:#0b0d11;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 120px}
h1{font-size:22px;margin:0 0 2px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;
color:var(--muted);margin:32px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
.sub{color:var(--muted);margin:0 0 8px}
.field{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.field label{font-weight:600;display:block;margin-bottom:2px}
.field .help{color:var(--muted);font-size:12.5px;margin:2px 0 10px}
.field.sensitive{border-left:3px solid var(--warn)}
.tag{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;
color:var(--warn);border:1px solid var(--warn);border-radius:4px;padding:0 5px;margin-left:8px}
input[type=text],input[type=url],input[type=number],textarea,select{
width:100%;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
textarea{min-height:64px;resize:vertical}
input[type=checkbox]{width:18px;height:18px;vertical-align:middle}
.row{display:flex;gap:8px;align-items:center;margin:4px 0}
.row input{flex:1}
.btn{font:13px inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel);
color:var(--ink);border-radius:7px;padding:6px 12px}
.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn.small{padding:3px 9px;font-size:12px}
.persona{border:1px dashed var(--line);border-radius:8px;padding:12px;margin:8px 0}
.persona .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);
padding:12px 20px;display:flex;gap:10px;align-items:center;justify-content:center}
.bar .note{color:var(--muted);font-size:12px;margin-right:auto}
dialog{max-width:760px;width:92%;border:1px solid var(--line);border-radius:12px;background:var(--panel);
color:var(--ink);padding:0}
dialog pre{margin:0;padding:16px;max-height:60vh;overflow:auto;background:var(--code);
font:12px ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
dialog .head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.err{color:var(--bad);font-size:12px;margin-top:6px;display:none}
nav.groups{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;flex-wrap:wrap;gap:6px;z-index:5}
nav.groups a{font-size:12px;color:var(--accent);text-decoration:none;border:1px solid var(--line);
border-radius:999px;padding:3px 10px}
</style></head>
<body><div class="wrap">
<h1>QA config editor</h1>
<p class="sub">Editing the effective config from <code>${esc(CONFIG_PATH)}</code>.
Change what you need, then <strong>Download</strong> a fresh <code>qa.config.json</code> and drop it in the project root.
Nothing here is sent anywhere &mdash; this page is offline.</p>
<nav class="groups" id="nav"></nav>
<form id="form"></form>

<div class="bar">
  <span class="note" id="status">ready</span>
  <button type="button" class="btn" id="preview">Preview JSON</button>
  <button type="button" class="btn" id="copy">Copy</button>
  <button type="button" class="btn primary" id="download">Download qa.config.json</button>
</div>

<dialog id="dlg">
  <div class="head"><strong>qa.config.json</strong><button type="button" class="btn small" id="closeDlg">Close</button></div>
  <pre id="json"></pre>
</dialog>

<script type="application/json" id="data">${data}</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const form = document.getElementById("form");
const nav = document.getElementById("nav");

function listToText(v){ return Array.isArray(v) ? v.join("\\n") : ""; }
function textToList(s){ return s.split("\\n").map(x=>x.trim()).filter(Boolean); }

// --- render the flat fields, grouped
for (const group of D.groups) {
  const fields = D.fields.filter(f => f.group === group);
  if (!fields.length) continue;
  const h = document.createElement("h2"); h.textContent = group; h.id = "g-"+group.replace(/\\W+/g,"-");
  form.appendChild(h);
  const a = document.createElement("a"); a.href = "#"+h.id; a.textContent = group; nav.appendChild(a);

  for (const f of fields) {
    const box = document.createElement("div");
    box.className = "field" + (f.sensitive ? " sensitive" : "");
    const v = D.values[f.key];
    let control;
    if (f.type === "boolean") {
      control = '<input type="checkbox" data-key="'+f.key+'" '+(v?"checked":"")+'>';
    } else if (f.type === "number") {
      control = '<input type="number" data-key="'+f.key+'" value="'+(v??"")+'"'+
        (f.min!=null?' min="'+f.min+'"':'')+(f.max!=null?' max="'+f.max+'"':'')+'>';
    } else if (f.type === "stringList") {
      control = '<textarea data-key="'+f.key+'" data-list="1" placeholder="'+(f.placeholder||"one per line")+'">'+
        esc(listToText(v))+'</textarea>';
    } else {
      control = '<input type="'+(f.type==="url"?"url":"text")+'" data-key="'+f.key+'" value="'+esc(v==null?"":String(v))+
        '" placeholder="'+esc(f.placeholder||"")+'">';
    }
    box.innerHTML = '<label>'+esc(f.label)+(f.sensitive?'<span class="tag">safety</span>':'')+'</label>'+
      '<div class="help">'+esc(f.help)+'</div>'+control;
    form.appendChild(box);
  }
}

// --- login section
const login = D.values.login || {};
const LOGIN_FIELDS = [
  ["path","Login path","/login"],["usernameLabel","Username field label","Username"],
  ["passwordLabel","Password field label","Password"],["submitLabel","Submit button","Login"],
  ["successUrl","Success URL pattern (regex)","/secure$"],["successText","Success text (optional)",""],
  ["username","Username (optional; env wins)",""],["password","Password (optional; env wins)",""],
];
const lh = document.createElement("h2"); lh.textContent="Login"; lh.id="g-login"; form.appendChild(lh);
nav.insertAdjacentHTML("beforeend",'<a href="#g-login">Login</a>');
const lbox = document.createElement("div"); lbox.className="field sensitive";
lbox.innerHTML = '<label>How to sign in to this target<span class="tag">safety</span></label>'+
  '<div class="help">How the login form is found and what proves it worked. Leave empty to use the demo defaults. '+
  'Credentials belong in the TEST_USERNAME / TEST_PASSWORD env vars for anything real &mdash; env always wins over these.</div>'+
  '<div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px">'+
  LOGIN_FIELDS.map(([k,label,ph])=>'<div><div class="help" style="margin:0 0 3px">'+esc(label)+'</div>'+
    '<input type="text" data-login="'+k+'" value="'+esc(login[k]==null?"":String(login[k]))+'" placeholder="'+esc(ph)+'"></div>').join("")+
  '</div>';
form.appendChild(lbox);

// --- personas section
const ph = document.createElement("h2"); ph.textContent="Personas"; ph.id="g-personas"; form.appendChild(ph);
nav.insertAdjacentHTML("beforeend",'<a href="#g-personas">Personas</a>');
const pwrap = document.createElement("div");
pwrap.innerHTML='<div class="help" style="margin-bottom:8px">Separate identities for multi-user and cross-user authorization tests. '+
  'Each needs its own account on the target for the authz scan to mean anything.</div>';
const plist = document.createElement("div"); pwrap.appendChild(plist);
const addBtn = document.createElement("button"); addBtn.type="button"; addBtn.className="btn small"; addBtn.textContent="+ Add persona";
pwrap.appendChild(addBtn); form.appendChild(pwrap);

function personaRow(p){
  const d = document.createElement("div"); d.className="persona";
  d.innerHTML='<div class="grid">'+
    ['id','role','username','password'].map(k=>'<div><div class="help" style="margin:0 0 3px">'+k+'</div>'+
      '<input type="text" data-p="'+k+'" value="'+esc(p&&p[k]!=null?String(p[k]):"")+'"></div>').join("")+
    '</div><div style="margin-top:8px"><button type="button" class="btn small rm">Remove</button></div>';
  d.querySelector(".rm").onclick=()=>d.remove();
  return d;
}
(Array.isArray(D.values.personas)?D.values.personas:[]).forEach(p=>plist.appendChild(personaRow(p)));
addBtn.onclick=()=>plist.appendChild(personaRow({}));

// --- collect the form back into a config object
function collect(){
  const out = JSON.parse(JSON.stringify(D.values)); // start from the loaded config, keep unknown keys
  form.querySelectorAll("[data-key]").forEach(el=>{
    const key = el.dataset.key;
    if (el.type==="checkbox") out[key]=el.checked;
    else if (el.type==="number") out[key]=el.value===""?undefined:Number(el.value);
    else if (el.dataset.list) out[key]=textToList(el.value);
    else out[key]=el.value;
  });
  const lg={};
  form.querySelectorAll("[data-login]").forEach(el=>{ if(el.value.trim()) lg[el.dataset.login]=el.value; });
  if (Object.keys(lg).length) out.login=lg; else delete out.login;
  const people=[];
  plist.querySelectorAll(".persona").forEach(row=>{
    const p={}; row.querySelectorAll("[data-p]").forEach(el=>{ if(el.value.trim()) p[el.dataset.p]=el.value; });
    if (p.id) people.push(p);
  });
  out.personas=people;
  return out;
}

function json(){ return JSON.stringify(collect(), null, 2)+"\\n"; }
const status=document.getElementById("status");
function flash(msg){ status.textContent=msg; setTimeout(()=>status.textContent="ready",2500); }

document.getElementById("preview").onclick=()=>{ document.getElementById("json").textContent=json();
  document.getElementById("dlg").showModal(); };
document.getElementById("closeDlg").onclick=()=>document.getElementById("dlg").close();
document.getElementById("copy").onclick=async()=>{ try{ await navigator.clipboard.writeText(json()); flash("copied to clipboard"); }
  catch{ flash("copy failed - use Preview and select"); } };
document.getElementById("download").onclick=()=>{
  const blob=new Blob([json()],{type:"application/json"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="qa.config.json";
  a.click(); URL.revokeObjectURL(a.href); flash("downloaded qa.config.json");
};
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
</script>
</body></html>
`;
}

function main(): void {
  const html = buildConfigPage();
  const out = resolve(OUT, "config.html");
  writeFileSync(out, html);
  console.log(`wrote ${out}`);
  console.log("Open it in a browser, edit, then Download a fresh qa.config.json into the project root.");
}

if (process.argv[1]?.endsWith("configpage.ts")) main();
