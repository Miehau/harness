import assert from "node:assert/strict";
import { createServer } from "node:http";

const nvr = new URL(process.env.NVR_URL || "http://192.168.178.162");
const host = "127.0.0.1";
const port = Number(process.env.CAMERA_CONTROL_PORT || 4320);
const modes = { color: 0, automatic: 1, "black-and-white": 3 };
let rpcId = 1;

function setMode(table, value) {
  table[0].DayNightColor = value;
  for (const profile of [table[0].NightOptions, table[0].NormalOptions]) {
    if (profile) profile.DayNightColor = value;
  }
  return table;
}

async function rpc(method, params = null) {
  const response = await fetch(new URL("/RPC2", nvr), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-request": "JSON" },
    body: JSON.stringify({ method, params, session: 0, id: rpcId++ }),
    signal: AbortSignal.timeout(6000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`NVR returned HTTP ${response.status}`);
  try { return JSON.parse(text); } catch { throw new Error("NVR returned an invalid response"); }
}

async function config(channel) {
  const result = await rpc("configManager.getConfig", { channel, name: "VideoInOptions" });
  if (!result.result || !Array.isArray(result.params?.table)) throw new Error(`Cannot read Cam_${channel} configuration`);
  return result.params.table;
}

async function channels() {
  const state = await rpc("RemoteDeviceManager.getChannelState");
  const rows = state.params?.ChannelState;
  if (!state.result || !Array.isArray(rows)) throw new Error("Cannot read camera status");
  return Promise.all(rows.map(async (row, channel) => {
    const [device, table] = await Promise.all([
      rpc("RemoteDeviceManager.getDeviceInfo", { device: `Cam_${channel}` }),
      config(channel)
    ]);
    const info = device.params?.info?.[`Cam_${channel}`] || {};
    return {
      channel,
      name: `Cam_${channel}`,
      address: info.Address || "Unknown",
      online: row.State === "conf_NvrOK",
      bitrate: Number(row.BitRate) || 0,
      mode: Object.keys(modes).find((name) => modes[name] === table[0].DayNightColor) || "unknown"
    };
  }));
}

async function updateChannel(channel, mode) {
  if (!Number.isInteger(channel) || channel < 0 || channel > 7) throw new Error("Invalid channel");
  if (!(mode in modes)) throw new Error("Invalid mode");
  const table = setMode(await config(channel), modes[mode]);
  const result = await rpc("configManager.setConfig", { channel, name: "VideoInOptions", table, options: "" });
  if (!result.result) throw new Error(result.params?.error || `NVR rejected the Cam_${channel} change`);
  return { channel, mode };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Camera night control</title>
<style>
  :root { color-scheme: dark; font: 16px/1.45 system-ui, sans-serif; background:#0c1118; color:#e8edf5 }
  body { max-width:1050px; margin:auto; padding:32px 20px 60px }
  header { display:flex; align-items:end; justify-content:space-between; gap:20px; margin-bottom:24px }
  h1 { margin:0; font-size:clamp(1.7rem,4vw,2.6rem); letter-spacing:-.04em }
  p { color:#9eabbc; margin:.35rem 0 0 }
  button,select { font:inherit; color:inherit; border:1px solid #344153; border-radius:9px; background:#151d28; padding:9px 11px }
  button { cursor:pointer; background:#2478ff; border-color:#2478ff; font-weight:700 }
  button.secondary { background:#151d28; border-color:#344153 }
  button:disabled,select:disabled { opacity:.45; cursor:not-allowed }
  #message { min-height:24px; margin:12px 0; color:#ffbd66 }
  #cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:14px }
  article { background:#121923; border:1px solid #273344; border-radius:14px; padding:18px }
  article.offline { border-color:#6a3034 }
  .top { display:flex; justify-content:space-between; gap:12px; align-items:center }
  h2 { margin:0; font-size:1.1rem }
  .state { font-size:.82rem; color:#79dfa6 }
  .offline .state { color:#ff8488 }
  .meta { margin:12px 0 18px; color:#9eabbc; font-size:.9rem }
  .controls { display:grid; grid-template-columns:1fr auto; gap:9px }
  label { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0) }
  footer { margin-top:22px; color:#738197; font-size:.85rem }
</style>
<body>
<header><div><h1>Camera night control</h1><p>Local control through the NVR</p></div><button class="secondary" id="refresh">Refresh</button></header>
<div id="message" role="status"></div><main id="cards" aria-live="polite"></main>
<footer>Automatic enables the camera's light sensor to switch between colour and infrared night vision. Offline cameras cannot be changed.</footer>
<script>
const cards=document.querySelector('#cards'), message=document.querySelector('#message');
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function request(url,options){const response=await fetch(url,options);const data=await response.json().catch(()=>({error:'Invalid server response'}));if(!response.ok)throw new Error(data.error||'Request failed');return data}
async function load(){message.textContent='Loading cameras…';try{const list=await request('/api/channels');cards.innerHTML=list.map(camera=>\`
  <article class="\${camera.online?'':'offline'}">
    <div class="top"><h2>\${esc(camera.name)}</h2><span class="state">\${camera.online?'Online':'Offline'}</span></div>
    <div class="meta">\${esc(camera.address)} · \${camera.bitrate} kbps</div>
    <div class="controls"><label for="mode-\${camera.channel}">Night mode</label><select id="mode-\${camera.channel}" \${camera.online?'':'disabled'}>
      <option value="automatic" \${camera.mode==='automatic'?'selected':''}>Automatic</option>
      <option value="color" \${camera.mode==='color'?'selected':''}>Always colour</option>
      <option value="black-and-white" \${camera.mode==='black-and-white'?'selected':''}>Always infrared/B&amp;W</option>
    </select><button data-channel="\${camera.channel}" \${camera.online?'':'disabled'}>Apply</button></div>
  </article>\`).join('');message.textContent=''}catch(error){cards.innerHTML='';message.textContent=error.message+' — check that this Mac is on the home network.'}}
cards.addEventListener('click',async event=>{const button=event.target.closest('button[data-channel]');if(!button)return;const channel=Number(button.dataset.channel),select=document.querySelector('#mode-'+channel),label=select.options[select.selectedIndex].text;if(!confirm('Set Cam_'+channel+' to '+label+'?'))return;button.disabled=true;message.textContent='Applying Cam_'+channel+'…';try{await request('/api/channels/'+channel,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:select.value})});await load()}catch(error){message.textContent=error.message;button.disabled=false}});
document.querySelector('#refresh').addEventListener('click',load);load();
</script>
</body></html>`;

if (process.argv.includes("--self-test")) {
  const table = [{ DayNightColor: 0, Other: 42, NightOptions: { DayNightColor: 0 } }];
  setMode(table, modes.automatic);
  assert.deepEqual(table, [{ DayNightColor: 1, Other: 42, NightOptions: { DayNightColor: 1 } }]);
  console.log("camera-control self-test passed");
} else {
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return response.end(page);
      }
      if (request.method === "GET" && url.pathname === "/api/channels") return json(response, 200, await channels());
      const match = url.pathname.match(/^\/api\/channels\/(\d+)$/);
      if (request.method === "POST" && match) return json(response, 200, await updateChannel(Number(match[1]), (await readJson(request)).mode));
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 502, { error: error.message });
    }
  }).listen(port, host, () => console.log(`Camera control: http://${host}:${port}`));
}
