/* ============ PHASE 3: live schedule panel (added 2026-11-12) ============
   Shows the next 7 days of the Housecall Pro schedule in the right-hand panel,
   read through the read-only `hcp-schedule` Supabase function. Shared by
   index.html and beta.html. Needs window.__P2.callFn and a #schedBox element. */
(function(){
const P2=window.__P2, box=document.getElementById("schedBox");
if(!box||!P2||!P2.callFn||!window.SchedPoints) return;

const DAYS=7, MAX_WEEKS=4, REFRESH_MS=60000;
// Points and caps: intake/points.js + intake/schedule-settings.js (Scheduling Playbook rules).
const SP=window.SchedPoints, CFG=window.SCHED_SETTINGS||{crewTogether:true,crewCap:7,sameDayExtra:1,points:{},commercialTags:[],applianceTags:[]};
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
'.sc-date{font-weight:800;font-size:12.5px;white-space:nowrap}',
'.sc-tag{white-space:nowrap;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.3px;background:#dbeafe;color:#1e40af;border-radius:999px;padding:1px 6px}',
'.sc-tag.in{background:#059669;color:#fff}',
'.sc-load{margin-left:auto;font-size:11px;font-weight:800;border-radius:999px;padding:1px 8px;background:#e5e7eb;color:#374151;white-space:nowrap}',
'.sc-load.near{background:#fde68a;color:#78350f}',
'.sc-load.full{background:#fee2e2;color:#b91c1c}',
'.sc-load.none{background:#f3f4f6;color:#6b7280}',
'.sc-load.over{background:#b91c1c;color:#fff}',
'.sc-techs{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}',
'.sc-tech{font-size:10.5px;font-weight:800;border-radius:999px;padding:1px 7px;background:#e5e7eb;color:#374151}',
'.sc-tech.near{background:#fde68a;color:#78350f}',
'.sc-tech.full{background:#fee2e2;color:#b91c1c}',
'.sc-tech.over{background:#b91c1c;color:#fff}',
'.sc-best{border:1px solid #c7d2fe;background:#f5f7ff;border-radius:8px;padding:8px 9px;margin:6px 0 8px}',
'.sc-bt{font-weight:800;font-size:12.5px;color:#1e3a8a;margin-bottom:2px}',
'.sc-spot{border-top:1px solid #e0e7ff;padding:6px 0 2px;margin-top:5px;font-size:12px}',
'.sc-sl{display:flex;align-items:center;gap:6px}',
'.sc-add{font-size:11px;font-weight:800;background:#dcfce7;color:#166534;border-radius:999px;padding:1px 7px}',
'.sc-why{margin-left:auto;font-size:11.5px}',
'.sc-whyb{font-size:11.5px;color:#374151;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px 7px;margin-top:4px;line-height:1.45}',
'.sc-pts{display:inline-block;font-size:9.5px;font-weight:800;border-radius:999px;padding:0 6px;margin-left:4px;background:#ede9fe;color:#5b21b6;vertical-align:1px}',
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

/* ---------- the caller's position and size, for drive-time ranking ---------- */
const RT=window.SchedRoute;
// Exact when a returning customer is picked in HCP (their address has coordinates);
// otherwise the center of the city the CSR picked (approximate).
function callerPoint(){
  try{
    const h=S.hcp||{}, list=(h.cust&&h.cust.addresses)||[];
    const ad=list.find(x=>x.id===h.addrId)||(list.length===1?list[0]:null);
    const lat=ad&&Number(ad.latitude), lng=ad&&Number(ad.longitude);
    if(ad&&isFinite(lat)&&isFinite(lng)&&lat&&lng) return {lat,lng,exact:true,label:[ad.street,ad.city].filter(Boolean).join(", ")};
  }catch(e){}
  const c=area(), cc=(CFG.cityCenters||{})[c];
  return cc?{lat:cc.lat,lng:cc.lng,exact:false,label:c}:null;
}
// Points the new job will take: same rules as booked jobs.
function newJobPoints(){
  let apps=[], biz=false;
  try{ apps=[...new Set((S.units||[]).map(u=>u.app).filter(Boolean))]; biz=typeof isCommercial==="function"&&isCommercial(); }catch(e){}
  return SP.jobPoints({tags:apps,customer_tags:biz?["Commercial"]:[],desc:""},CFG).points;
}
function hourOf(t){ const p=parts(t); return p.hour+p.minute/60; }

/* ---------- data ---------- */
let rankData=null, rankAt=0, rankSeq=0, rankErr="";
const why=new Set();
// The next rankDays days, starting tomorrow (same-day is offered separately).
function loadRank(){
  if(!P2.state().online||!RT) return;
  const my=++rankSeq, first=addDays(dayKey(Date.now()),1);
  const body={from:new Date(midnight(first)).toISOString(),to:new Date(midnight(addDays(first,CFG.rankDays||14))).toISOString()};
  P2.callFn("hcp-schedule",body)
    .then(d=>{ if(my!==rankSeq) return; rankData=Object.assign({first},d); rankErr=""; rankAt=Date.now(); })
    .catch(e=>{ if(my!==rankSeq) return; rankErr=(e&&e.message)||"Could not load"; })
    .then(()=>{ if(my===rankSeq) paint(); });
}
function load(silent){
  if(callerPoint()) loadRank();
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
const RANK={open:0,near:1,full:2,over:3};
const fmtPts=n=>String(Math.round(n*10)/10);
// One line for the day header: crew points, or the busiest tech's status with each tech's points below.
function loadLabel(load){
  const rows=load.rows, worst=rows.reduce((w,r)=>RANK[SP.status(r)]>RANK[w]?SP.status(r):w,"open");
  const tag=s=>s==="over"?' · over cap':s==="full"?' · full':s==="near"?' · near cap':'';
  // At the cap: say whether the same-day point is still free or already used.
  const fullTag=r=>r.points>r.cap?' · same-day used':r.extra?' · same-day only':' · full';
  if(load.mode==="crew"){ const r=rows[0], s=SP.status(r); return {cls:worst,text:fmtPts(r.points)+'/'+r.cap+' pts'+(s==="full"?fullTag(r):tag(s)),
    tip:'Jacob and Jules ride together: every job counts once against the crew cap of '+r.cap+(r.extra?' (+'+r.extra+' for same-day)':'')+'.'}; }
  // Per tech: a job shared by two techs counts for each, so no day total here; name who is full instead.
  const fullNames=rows.filter(r=>RANK[SP.status(r)]>=2).map(r=>r.who), nearNames=rows.filter(r=>SP.status(r)==="near").map(r=>r.who);
  const text=fullNames.length?fullNames.join(' + ')+' full':nearNames.length?nearNames.join(' + ')+' near cap':'Room for all';
  return {cls:worst,text,tip:'Points per tech are listed below the date.'};
}
/* Best spots for the caller: days in the next rankDays, ranked by added drive time. */
function bestSpots(){
  const pt=callerPoint();
  if(!pt||!RT) return '';
  let h='<div class="sc-best"><div class="sc-bt">Best spots for this caller</div>';
  const where=pt.exact?'their address in HCP':'the center of '+esc(pt.label)+' (pick the customer in HCP for their exact address)';
  if(!rankData) return h+'<div class="hm">'+(rankErr?'Couldn\'t rank days: '+esc(rankErr):'Ranking the next '+(CFG.rankDays||14)+' days…')+'</div></div>';
  const newPts=newJobPoints(), work=CFG.workDays||[1,2,3,4,5];
  const byDay={};
  for(let i=0;i<(CFG.rankDays||14);i++){ const k=addDays(rankData.first,i); byDay[k]={jobs:[],events:[]}; }
  (rankData.jobs||[]).forEach(j=>{ const d=byDay[dayKey(j.start)]; if(d) d.jobs.push(j); });
  (rankData.events||[]).forEach(e=>{ const d=byDay[dayKey(e.start)]; if(d) d.events.push(e); });
  const days=[];
  Object.keys(byDay).forEach(k=>{
    const d=byDay[k], dow=new Date(k+"T12:00:00Z").getUTCDay();
    if(!work.includes(dow)&&!d.jobs.length) return; // no work that day
    const pts=j=>SP.jobPoints(j,CFG).points, sum=js=>js.reduce((a,j)=>a+pts(j),0);
    const asStops=js=>js.map(j=>({start:j.start,lat:j.lat,lng:j.lng,city:title(j.city)||"Stop",points:pts(j)}));
    if(CFG.crewTogether){
      days.push({key:k,label:dayLabel(k),jobs:asStops(d.jobs),events:d.events,load:{points:sum(d.jobs),cap:CFG.crewCap||7,extra:CFG.sameDayExtra||0}});
    } else Object.keys(CFG.techs||{}).forEach(t=>{
      const mine=d.jobs.filter(j=>(j.techs||[]).some(x=>x.split(" ")[0]===t));
      const evs=d.events.filter(e=>!(e.techs||[]).length||(e.techs||[]).some(x=>x.split(" ")[0]===t));
      days.push({key:k,label:dayLabel(k)+' · '+t,jobs:asStops(mine),events:evs,load:{points:sum(mine),cap:CFG.techs[t].cap,extra:CFG.sameDayExtra||0}});
    });
  });
  const r=RT.rank(days,pt,CFG,{newPoints:newPts,blocks:CFG.blocks,blockCaps:CFG.blockCaps,hourOf});
  h+='<div class="hm">From '+where+'. This job counts '+fmtPts(newPts)+(newPts===1?' point':' points')+'.</div>';
  if(r.far) return h+'<div class="note">About '+r.fromShop+' min from the shop, over the '+(CFG.farMinutes||45)+'-minute limit. Check with the technician before offering a day.</div></div>';
  if(!r.spots.length) return h+'<div class="note">No open spot in the next '+(CFG.rankDays||14)+' days within the point caps. Check with the technician.</div></div>';
  r.spots.slice(0,3).forEach((s,i)=>{
    const id=s.day+s.block+s.label, open=why.has(id);
    h+='<div class="sc-spot"><div class="sc-sl"><b>'+esc(s.label)+' · '+s.block+'</b><span class="sc-add">+'+s.added+' min drive</span>'+
       '<button class="hlink sc-why" data-why="'+esc(id)+'">'+(open?'Hide':'Why?')+'</button></div>'+
       '<div class="hm">'+(s.emptyDay?'Nothing booked yet: '+s.added+' min out from the shop.':'After '+esc(s.after)+(s.before?', before '+esc(s.before):', last stop of the day'))+'</div>';
    if(open){
      const legs=s.before
        ? esc(s.after)+' → this caller '+s.legs.toNew+' min, then → '+esc(s.before)+' '+s.legs.fromNew+' min, instead of '+esc(s.after)+' → '+esc(s.before)+' '+s.legs.skipped+' min. Adds '+s.added+' min.'
        : esc(s.after)+' → this caller '+s.legs.toNew+' min.';
      h+='<div class="sc-whyb">'+legs+'<br>Day after booking: '+fmtPts(s.pointsAfter)+'/'+s.cap+' pts · '+s.block+' '+fmtPts(s.blockPointsAfter)+'/'+s.blockCap+' pts.'+
         (s.unplaced?'<br>'+s.unplaced+' job(s) that day have no map position and were left out of the route.':'')+
         (pt.exact?'':'<br>Drive times use the city center, so they are rough until the exact address is known.')+'</div>';
    }
    h+='</div>';
  });
  return h+'<div class="sc-foot">Drive times are estimates from straight-line distance. Customers still get a 4-hour AM/PM block; the exact window is set the day before.</div></div>';
}
function jobBadge(s){
  if(s.points<=1) return '';
  const why=[s.commercial?'Commercial':'',s.appliances>1?s.appliances+' appliances':''].filter(Boolean).join(', ');
  return '<span class="sc-pts" title="'+esc(why)+'">'+fmtPts(s.points)+' pts'+(why?' · '+esc(why):'')+'</span>';
}

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
  h+=bestSpots();

  keys.forEach(k=>{
    const d=by[k], n=d.jobs.length, hit=inArea(k), isOpen=open.has(k);
    const load=SP.dayLoad(d.jobs,CFG), lab=loadLabel(load);
    const pts=new Map(load.scored.map(s=>[s.job,s]));
    const amPts=load.scored.filter(s=>isAM(s.job.start)).reduce((a,s)=>a+s.points,0);
    const allPts=load.scored.reduce((a,s)=>a+s.points,0);
    const cities={}; d.jobs.forEach(j=>{ const c=title(j.city)||"No city"; cities[c]=(cities[c]||0)+1; });
    const cls=n===0?'none':lab.cls==='open'?'':lab.cls;
    const lbl=n===0?'No jobs':lab.text;
    h+='<div class="sc-day'+(hit?' area':'')+'"><button class="sc-head" data-scday="'+k+'" aria-expanded="'+isOpen+'"'+(n?'':' disabled style="cursor:default"')+'>'+
       '<span class="sc-caret">'+(n?(isOpen?'▾':'▸'):'')+'</span><span class="sc-date">'+esc(dayLabel(k))+'</span>'+
       (k===today?'<span class="sc-tag">Today</span>':'')+(hit?'<span class="sc-tag in">In area</span>':'')+
       '<span class="sc-load '+cls+'" title="'+esc(lab.tip)+'">'+esc(lbl)+'</span></button>';
    if(n||d.events.length){
      h+='<div class="sc-body">';
      if(n) h+='<div class="sc-sub">'+n+(n===1?' job':' jobs')+' · AM '+fmtPts(amPts)+' pts · PM '+fmtPts(allPts-amPts)+' pts</div>';
      if(n&&load.mode==="tech") h+='<div class="sc-techs">'+load.rows.map(r=>{ const s=SP.status(r); return '<span class="sc-tech '+(s==='open'?'':s)+'">'+esc(r.who)+' '+fmtPts(r.points)+(r.cap!=null?'/'+r.cap:'')+'</span>'; }).join('')+'</div>';
      if(n) h+='<div class="sc-cities">'+Object.keys(cities).sort().map(c=>'<span class="sc-city'+(norm(c)===an?' hit':'')+'">'+esc(c)+(cities[c]>1?' '+cities[c]:'')+'</span>').join('')+'</div>';
      d.events.forEach(e=>{ h+='<div class="sc-block"><b>'+(e.all_day?'All day':esc(span(e.start,e.end)))+'</b> · '+esc(e.name||"Calendar block")+'</div>'; });
      if(isOpen) d.jobs.forEach(j=>{ h+='<div class="sc-job"><b>'+esc(span(j.start,jobEnd(j)))+'</b> · '+esc(title(j.city)||"No city")+' · '+esc(j.name||"")+jobBadge(pts.get(j))+
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
// Repaint when anything the panel shows changes: the caller's city or address, or the new job's size.
let lastSig="";
function sig(){ const p=callerPoint(); return area()+"|"+(p?p.lat.toFixed(4)+","+p.lng.toFixed(4):"")+"|"+newJobPoints(); }
function sync(){
  const on=P2.state().online;
  if(on!==wasOnline){ wasOnline=on; if(on) load(); else { data=null; rankData=null; err=""; loadedAt=0; paint(); } return; }
  const s=sig(); if(s===lastSig) return; lastSig=s;
  if(callerPoint()&&!rankData) loadRank();
  paint();
}
box.addEventListener("click",e=>{
  if(e.target.id==="scRefresh"){ load(); return; }
  const w=e.target.closest("[data-why]"); if(w){ const id=w.dataset.why; if(why.has(id)) why.delete(id); else why.add(id); paint(); return; }
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
