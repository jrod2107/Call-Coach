/* ============ PHASE 3: live schedule panel (added 2026-11-12) ============
   Shows the next 7 days of the Housecall Pro schedule in the right-hand panel,
   read through the read-only `hcp-schedule` Supabase function. Shared by
   index.html and beta.html. Needs window.__P2.callFn and a #schedBox element. */
(function(){
const P2=window.__P2, box=document.getElementById("schedBox");
if(!box||!P2||!P2.callFn) return;

const DAYS=7, MAX_WEEKS=4, REFRESH_MS=60000;
const NEAR=6, FULL=7;   // "Max 6-7 jobs per tech per day"
let tz="America/Chicago", data=null, err="", loading=false, seq=0, week=0, loadedAt=0, wasOnline=null, lastArea=null;
const open=new Set();

const css=document.createElement("style");
css.textContent=[
'#schedBox .sc-top{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
'#schedBox .sc-top .ptitle{margin:0}',
'.sc-upd{margin-left:auto;font-size:10.5px;color:#6b7280}',
'.sc-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px;font-weight:700;color:#374151}',
'.sc-nav button{border:1px solid #d1d5db;background:#fff;border-radius:6px;padding:2px 10px;cursor:pointer;font-weight:800;color:#1e40af;font-size:13px}',
'.sc-nav button:disabled{opacity:.35;cursor:default}',
'.sc-day{border:1px solid #e5e7eb;border-radius:8px;margin-top:6px;overflow:hidden}',
'.sc-day.area{border-color:#059669;box-shadow:inset 3px 0 0 #059669}',
'.sc-head{display:flex;align-items:center;gap:6px;width:100%;padding:7px 9px;background:#f9fafb;border:0;cursor:pointer;font:inherit;text-align:left;color:inherit}',
'.sc-head:hover{background:#eff6ff}',
'.sc-caret{font-size:10px;color:#6b7280;width:9px}',
'.sc-date{font-weight:800;font-size:12.5px}',
'.sc-tag{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;background:#dbeafe;color:#1e40af;border-radius:999px;padding:1px 6px}',
'.sc-tag.in{background:#059669;color:#fff}',
'.sc-load{margin-left:auto;font-size:11px;font-weight:800;border-radius:999px;padding:1px 8px;background:#e5e7eb;color:#374151;white-space:nowrap}',
'.sc-load.near{background:#fde68a;color:#78350f}',
'.sc-load.full{background:#fee2e2;color:#b91c1c}',
'.sc-load.none{background:#f3f4f6;color:#6b7280}',
'.sc-body{padding:6px 9px 8px}',
'.sc-sub{font-size:11.5px;color:#4b5563}',
'.sc-cities{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}',
'.sc-city{font-size:10.5px;font-weight:700;background:#f3f4f6;color:#374151;border-radius:999px;padding:1px 7px}',
'.sc-city.hit{background:#059669;color:#fff}',
'.sc-block{font-size:11.5px;color:#713f12;background:#fefce8;border-left:3px solid #f59e0b;border-radius:4px;padding:3px 6px;margin-top:5px;line-height:1.35;overflow-wrap:anywhere}',
'.sc-job{font-size:11.5px;padding:5px 0 0;border-top:1px solid #e5e7eb;margin-top:6px;line-height:1.4;overflow-wrap:anywhere}',
'.sc-foot{font-size:10.5px;color:#6b7280;margin-top:8px;line-height:1.4}'
].join("\n");
document.head.appendChild(css);

/* ---------- dates, always in the company time zone ---------- */
const pad=n=>String(n).padStart(2,"0");
function parts(t){ const p={}; new Intl.DateTimeFormat("en-US",{timeZone:tz,hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).formatToParts(new Date(t)).forEach(x=>{ if(x.type!=="literal") p[x.type]=+x.value; }); return p; }
function dayKey(t){ const p=parts(t); return p.year+"-"+pad(p.month)+"-"+pad(p.day); }
function addDays(key,n){ const d=new Date(key+"T12:00:00Z"); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function midnight(key){ const a=key.split("-").map(Number), want=Date.UTC(a[0],a[1]-1,a[2]); let g=want;
  for(let i=0;i<2;i++){ const p=parts(g); g-=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-want; } return g; }
function dayLabel(key){ return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",weekday:"short",month:"numeric",day:"numeric"}).format(new Date(key+"T12:00:00Z")).replace(",",""); }
function clockFull(t){ return new Intl.DateTimeFormat("en-US",{timeZone:tz,hour:"numeric",minute:"2-digit"}).format(new Date(t)); }
function clock(t){ return clockFull(t).replace(":00",""); }
function span(a,b){ const x=clock(a), y=clock(b); return (x.slice(-2)===y.slice(-2)?x.slice(0,-3):x)+"–"+y; }
function isAM(t){ return parts(t).hour<12; }

/* ---------- the caller's area, from the intake form ---------- */
const norm=s=>String(s||"").toLowerCase().replace(/\s+/g," ").trim();
const title=s=>norm(s).replace(/(^|\s)[a-z]/g,c=>c.toUpperCase());
function area(){ let c=""; try{ c=S.g[CU_city.id]||""; if(!c||c==="Other") c=S.cust.cityTxt||""; }catch(e){} c=title(c); return c.length>=3?c:""; }

/* ---------- data ---------- */
function load(silent){
  if(!P2.state().online) return;
  const my=++seq; loading=true; if(!silent) paint();
  const first=addDays(dayKey(Date.now()),week*DAYS);
  const body={from:new Date(midnight(first)).toISOString(),to:new Date(midnight(addDays(first,DAYS))).toISOString()};
  P2.callFn("hcp-schedule",body)
    .then(d=>{ if(my!==seq) return; if(d.tz) tz=d.tz; data=Object.assign({first},d); err=""; loadedAt=Date.now(); })
    .catch(e=>{ if(my!==seq) return; err=(e&&e.message)||"Could not load"; })
    .then(()=>{ if(my===seq){ loading=false; paint(); } });
}

function jobEnd(j){ return j.window?+new Date(j.start)+j.window*60000:+new Date(j.end); }
// Jobs on the busiest tech's day. Two techs on one job count once for each of them.
function dayLoad(jobs){ const per={}; let max=0; jobs.forEach(j=>(j.techs||[]).forEach(t=>{ per[t]=(per[t]||0)+1; if(per[t]>max) max=per[t]; })); return max||jobs.length; }

/* ---------- render ---------- */
function paint(){
  lastArea=area();
  let h='<div class="sc-top"><div class="ptitle">Live schedule</div>';
  if(!P2.state().online){ box.innerHTML=h+'</div><div class="note">Sign in to see the Housecall Pro schedule here.</div>'; return; }
  h+='<span class="sc-upd">'+(loading?'Updating…':loadedAt?'Updated '+esc(clockFull(loadedAt)):'')+'</span><button class="hlink" id="scRefresh">Refresh</button></div>';
  const first=addDays(dayKey(Date.now()),week*DAYS), keys=[]; for(let i=0;i<DAYS;i++) keys.push(addDays(first,i));
  h+='<div class="sc-nav"><button id="scPrev" title="Earlier"'+(week<=0?' disabled':'')+'>‹</button><span>'+esc(dayLabel(keys[0]))+' – '+esc(dayLabel(keys[DAYS-1]))+'</span><button id="scNext" title="Later"'+(week>=MAX_WEEKS-1?' disabled':'')+'>›</button></div>';
  if(err) h+='<div class="qerr" style="margin-bottom:6px">Schedule didn\'t load: '+esc(err)+(data&&data.first===first?' Showing the copy from '+esc(clockFull(loadedAt))+'.':'')+'</div>';
  if(!data||data.first!==first){ box.innerHTML=h+(err?'':'<div class="hm">Loading the schedule…</div>'); return; }

  const by={}; keys.forEach(k=>by[k]={jobs:[],events:[]});
  (data.jobs||[]).forEach(j=>{ const d=by[dayKey(j.start)]; if(d) d.jobs.push(j); });
  (data.events||[]).forEach(e=>{ const d=by[dayKey(e.start)]; if(d) d.events.push(e); });
  const today=dayKey(Date.now()), a=lastArea, an=norm(a);
  const inArea=k=>!!an&&by[k].jobs.some(j=>norm(j.city)===an);

  if(a){ const hits=keys.filter(inArea);
    h+=hits.length?'<div class="note script"><b>'+esc(a)+'</b> is already on the schedule '+hits.map(k=>'<b>'+esc(dayLabel(k))+'</b>').join(', ')+'. Aim for one of those days.</div>'
                  :'<div class="note">No <b>'+esc(a)+'</b> jobs booked in these 7 days yet.</div>'; }

  keys.forEach(k=>{
    const d=by[k], n=d.jobs.length, ld=dayLoad(d.jobs), hit=inArea(k), isOpen=open.has(k);
    const am=d.jobs.filter(j=>isAM(j.start)).length;
    const cities={}; d.jobs.forEach(j=>{ const c=title(j.city)||"No city"; cities[c]=(cities[c]||0)+1; });
    const cls=n===0?'none':ld>=FULL?'full':ld>=NEAR?'near':'';
    const lbl=n===0?'No jobs':n+(n===1?' job':' jobs')+(ld>=FULL?' · full':ld>=NEAR?' · near limit':'');
    h+='<div class="sc-day'+(hit?' area':'')+'"><button class="sc-head" data-scday="'+k+'" aria-expanded="'+isOpen+'"'+(n?'':' disabled style="cursor:default"')+'>'+
       '<span class="sc-caret">'+(n?(isOpen?'▾':'▸'):'')+'</span><span class="sc-date">'+esc(dayLabel(k))+'</span>'+
       (k===today?'<span class="sc-tag">Today</span>':'')+(hit?'<span class="sc-tag in">In area</span>':'')+
       '<span class="sc-load '+cls+'" title="Busiest tech has '+ld+' on this day">'+lbl+'</span></button>';
    if(n||d.events.length){
      h+='<div class="sc-body">';
      if(n) h+='<div class="sc-sub">AM '+am+' · PM '+(n-am)+'</div><div class="sc-cities">'+Object.keys(cities).sort().map(c=>'<span class="sc-city'+(norm(c)===an?' hit':'')+'">'+esc(c)+(cities[c]>1?' '+cities[c]:'')+'</span>').join('')+'</div>';
      d.events.forEach(e=>{ h+='<div class="sc-block"><b>'+(e.all_day?'All day':esc(span(e.start,e.end)))+'</b> · '+esc(e.name||"Calendar block")+'</div>'; });
      if(isOpen) d.jobs.forEach(j=>{ h+='<div class="sc-job"><b>'+esc(span(j.start,jobEnd(j)))+'</b> · '+esc(title(j.city)||"No city")+' · '+esc(j.name||"")+
        '<div class="hm">'+esc([j.desc,(j.techs||[]).map(t=>t.split(" ")[0]).join(" + "),j.status&&j.status!=="scheduled"?j.status:""].filter(Boolean).join(" · "))+'</div></div>'; });
      h+='</div>';
    }
    h+='</div>';
  });
  const foot=[];
  if(data.events==null) foot.push("Calendar blocks couldn't be read, so only jobs are shown.");
  if(data.events_unsupported_rules) foot.push(data.events_unsupported_rules+" repeating block(s) use a repeat pattern this panel can't read. Check HCP.");
  if(data.truncated) foot.push("The schedule is too large to show in full. Check HCP.");
  foot.push("Times are arrival windows. Book the visit in HCP.");
  h+='<div class="sc-foot">'+foot.map(esc).join(" ")+'</div>';
  box.innerHTML=h;
}

/* ---------- wiring ---------- */
function sync(){
  const on=P2.state().online;
  if(on!==wasOnline){ wasOnline=on; if(on) load(); else { data=null; err=""; loadedAt=0; paint(); } return; }
  if(area()!==lastArea) paint();
}
box.addEventListener("click",e=>{
  if(e.target.id==="scRefresh"){ load(); return; }
  if(e.target.id==="scPrev"&&week>0){ week--; data=null; open.clear(); load(); return; }
  if(e.target.id==="scNext"&&week<MAX_WEEKS-1){ week++; data=null; open.clear(); load(); return; }
  const b=e.target.closest("[data-scday]"); if(b){ const k=b.dataset.scday; if(open.has(k)) open.delete(k); else open.add(k); paint(); }
});
document.addEventListener("input",e=>{ if(e.target.dataset&&e.target.dataset.c==="cityTxt") sync(); });
document.addEventListener("visibilitychange",()=>{ if(!document.hidden&&P2.state().online&&Date.now()-loadedAt>REFRESH_MS) load(true); });
setInterval(()=>{ if(P2.state().online&&!document.hidden) load(true); },REFRESH_MS);
const _render=render; window.render=render=function(){ _render(); sync(); };

window.Sched={sync,refresh:()=>load()};
sync();
})();
