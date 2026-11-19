/* shell.js: the one menu every page shares.

   Desktop: a dark menu down the left side. Phones: a bottom bar with at most five items, the last one opening
   the full menu. Pages that ask for it (data-bar="1") also get a top bar with job search and "New call".

   The menu is only a convenience: it shows the pages a role can use. What a person may actually read or change
   is decided by the database, never by this file.

   Use, as the first thing in <body>:
     <script src="../shell.js" data-base="../" data-page="jobs" data-bar="1"></script>
   data-base   path from this page to the site root ("" on the root page)
   data-page   which menu item is the current page
   Then the page calls AppShell.set(profile) once it knows who is signed in, and AppShell.set(null) when nobody is. */
(function(){
  if(window.AppShell)return;
  const me=document.currentScript,D=me.dataset,base=D.base||'',here=D.page||'',KEY='shell:me';
  const ic=p=>'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>';
  /* Order is the same on every page. `group` starts a new labelled section. */
  const NAV=[
    {k:'home',label:'Home',href:'home/',roles:['admin','csr','tech','stock'],icon:'<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>'},
    {k:'jobs',label:'Jobs',href:'jobs/',roles:['admin','csr','tech'],icon:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'},
    {k:'workorders',label:'Work orders',href:'workorders/',roles:['admin','csr'],icon:'<path d="M7 3h10v18H7z"/><path d="M10 8h4M10 12h4M10 16h2"/>'},
    {k:'parts',label:'Parts desk',href:'parts/',roles:['admin','csr','tech'],group:'Parts',icon:'<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'},
    {k:'stock',label:'Stock',href:'stock/',roles:['admin','csr','tech','stock'],icon:'<path d="M4 4v16M20 4v16M4 10h16M4 16h16"/><rect x="7" y="6" width="4" height="4"/><rect x="13" y="12" width="4" height="4"/>'},
    {k:'intake',label:'Call intake',href:'intake/',roles:['admin','csr'],group:'Calls',icon:'<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/>'},
    {k:'desk',label:'Call Desk',href:'desk/',roles:['admin','csr'],icon:'<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'},
    {k:'coach',label:'Call Coach',href:'',roles:['admin','csr'],icon:'<path d="M4 13a8 8 0 0 1 16 0"/><rect x="3" y="13" width="4" height="6" rx="1"/><rect x="17" y="13" width="4" height="6" rx="1"/><path d="M19 19a4 4 0 0 1-4 3h-2"/>'}
  ];
  const SETTINGS={k:'settings',label:'Settings',href:'settings/',roles:['admin','csr','tech','stock'],icon:'<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'};
  const MORE='<path d="M4 7h16M4 12h16M4 17h16"/>';
  const ROLE={admin:'Admin',manager:'Manager',csr:'Office',senior:'Senior technician',tech:'Technician',stock:'Stock helper'};
  const roleKey=u=>u.role==='csr'&&u.manager?'manager':u.role==='tech'&&u.senior?'senior':u.role;
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const css=':root{--as-w:216px;--as-side:#161b22;--as-ink:#e8eaed;--as-muted:#9aa3ad;--as-active:#262d38;--as-line:#2c333d;--as-accent:#1f62d6}'
    +'@media (prefers-color-scheme:dark){:root{--as-side:#0b0d0f;--as-active:#1c2026;--as-line:#23282f;--as-accent:#2f6fe0}}'
    +'.as-side,.as-tabs,.as-bar,.as-scrim{display:none}'
    +'.as-side,.as-tabs{font:500 14px/1.3 "Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}'
    +'.as-side *,.as-tabs *{box-sizing:border-box}'
    +'html.as-on body{margin-left:var(--as-w)!important}'
    +'html.as-on .as-side{display:flex;flex-direction:column;gap:16px;position:fixed;top:0;left:0;bottom:0;width:var(--as-w);z-index:30;background:var(--as-side);color:var(--as-ink);padding:16px 12px;padding-top:max(16px,env(safe-area-inset-top,0px));overflow-y:auto}'
    +'.as-brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;color:var(--as-ink);text-decoration:none;padding:0 4px}'
    +'.as-logo{width:28px;height:28px;border-radius:7px;background:var(--as-accent);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700;letter-spacing:.02em;flex:none}'
    +'.as-nav{display:flex;flex-direction:column;gap:2px;min-width:0}'
    +'.as-group{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--as-muted);padding:14px 10px 4px}'
    +'.as-side a.as-item,.as-side button.as-item{display:flex;align-items:center;gap:10px;min-height:38px;padding:8px 10px;border-radius:6px;border:0;background:none;width:100%;text-align:left;font:inherit;text-decoration:none;color:var(--as-muted);white-space:nowrap;cursor:pointer}'
    +'.as-side .as-item:hover{color:var(--as-ink)}'
    +'.as-side .as-item[aria-current="page"]{background:var(--as-active);color:var(--as-ink)}'
    +'.as-side .as-item:focus-visible,.as-tabs :focus-visible{outline:2px solid #82b4ff;outline-offset:1px}'
    +'.as-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--as-line);padding-top:10px}'
    +'.as-who{padding:6px 10px 2px;font-size:12px;color:var(--as-muted);overflow-wrap:anywhere}.as-who b{display:block;color:var(--as-ink);font-size:13px;font-weight:600}'
    /* top bar: only on pages that use the shared look, so it can use their colour tokens */
    +'html.as-on .as-bar{display:flex;gap:10px;align-items:center;padding:10px 20px;background:var(--surface,#fff);border-bottom:1px solid var(--line,#d8dce1)}'
    +'.as-bar form{flex:1;max-width:420px;display:flex;margin:0}.as-bar input{width:100%}'
    +'.as-bar .as-grow{flex:1}html.as-on .as-bar:empty{display:none}'
    +'.as-bar a.as-new{display:inline-flex;align-items:center;gap:6px;font-weight:600;text-decoration:none;white-space:nowrap;padding:7px 12px;border-radius:6px;background:var(--accent,#1f62d6);color:var(--accent-ink,#fff);border:1px solid var(--accent,#1f62d6)}'
    +'@media (max-width:860px){'
    +'html.as-on body{margin-left:0!important;margin-bottom:calc(60px + env(safe-area-inset-bottom,0px))!important}'
    +'html.as-on .as-side{width:min(290px,86vw);z-index:70;transform:translateX(-102%);padding-bottom:max(16px,env(safe-area-inset-bottom,0px))}'
    +'html.as-on.as-open .as-side{transform:none}'
    +'html.as-on.as-open .as-scrim{display:block;position:fixed;inset:0;z-index:65;background:rgba(0,0,0,.5);border:0;padding:0;width:100%;cursor:default}'
    +'.as-side a.as-item,.as-side button.as-item{min-height:44px}'
    +'html.as-on .as-tabs{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:30;background:var(--as-side);border-top:1px solid var(--as-line);padding-bottom:env(safe-area-inset-bottom,0px)}'
    +'.as-tabs a,.as-tabs button{flex:1 1 0;min-width:0;height:60px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border:0;background:none;font:inherit;font-size:11px;color:var(--as-muted);text-decoration:none;cursor:pointer;padding:0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    +'.as-tabs [aria-current="page"],.as-tabs [aria-expanded="true"]{color:#fff}'
    +'html.as-on .as-bar{padding:8px 12px}.as-bar .as-grow{display:none}'
    +'}'
    /* The menu now carries these, so the copies inside older pages are hidden while the menu is showing. */
    +'html.as-on #signOut,html.as-on a[aria-label="Back to Home"]{display:none!important}'
    +'@media print{.as-side,.as-tabs,.as-bar,.as-scrim{display:none!important}html.as-on body{margin:0!important}}';
  const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

  const side=document.createElement('aside');side.className='as-side';side.id='as-side';side.setAttribute('aria-label','Main menu');
  const tabs=document.createElement('nav');tabs.className='as-tabs';tabs.setAttribute('aria-label','Main menu');
  const scrim=document.createElement('button');scrim.className='as-scrim';scrim.type='button';scrim.setAttribute('aria-label','Close the menu');
  let bar=null;
  if(D.bar==='1'){bar=document.createElement('header');bar.className='as-bar'}
  const root=document.documentElement;
  const link=(n,cls)=>`<a class="${cls}" href="${base+n.href||'./'}"${n.k===here?' aria-current="page"':''}>${ic(n.icon)}<span>${esc(n.label)}</span></a>`;
  let user=null;

  function draw(){
    if(!user){root.classList.remove('as-on','as-open');return}
    const can=n=>n.roles.includes(user.role),items=NAV.filter(can);
    let h='';
    for(const n of items){if(n.group)h+=`<div class="as-group">${n.group}</div>`;h+=link(n,'as-item')}
    side.innerHTML=`<a class="as-brand" href="${base}home/"><span class="as-logo">CA</span>City Appliance</a>
      <nav class="as-nav" aria-label="Pages">${h}</nav>
      <div class="as-foot">${can(SETTINGS)?link(SETTINGS,'as-item'):''}
        <div class="as-who"><b>${esc(user.display_name||user.email||'')}</b>${esc(ROLE[roleKey(user)]||'')}</div>
        <button type="button" class="as-item" data-a="signout" data-as="signout">${ic('<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>')}<span>Sign out</span></button></div>`;
    /* Phones: the first four pages this role can use, then More. */
    tabs.innerHTML=items.slice(0,4).map(n=>link(n,'')).join('')
      +`<button type="button" data-as="more" aria-controls="as-side" aria-expanded="false">${ic(MORE)}<span>More</span></button>`;
    if(bar){
      const jobs=['admin','csr','tech'].includes(user.role),office=['admin','csr'].includes(user.role);
      bar.innerHTML=(jobs?`<form role="search" data-as="find"><input type="search" name="q" placeholder="Find a job: number, customer or city" aria-label="Find a job" autocomplete="off"></form>`:'')
        +(office?`<span class="as-grow"></span><a class="as-new" href="${base}intake/">+ New call</a>`:'');
    }
    root.classList.add('as-on');
  }
  function open(on){root.classList.toggle('as-open',on);const m=tabs.querySelector('[data-as="more"]');if(m)m.setAttribute('aria-expanded',on?'true':'false')}

  document.addEventListener('click',e=>{
    if(e.target===scrim){open(false);return}
    const el=e.target.closest('[data-as]');if(!el)return;
    if(el.dataset.as==='more')open(!root.classList.contains('as-open'));
    if(el.dataset.as==='signout'){
      /* Newer pages handle data-a="signout" themselves. Older pages have their own Sign out button: press it. */
      try{localStorage.removeItem(KEY)}catch(x){}
      const old=document.getElementById('signOut');if(old)old.click();
    }
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&root.classList.contains('as-open'))open(false)});
  document.addEventListener('submit',e=>{
    if(!e.target.matches||!e.target.matches('form[data-as="find"]'))return;e.preventDefault();
    const q=e.target.q.value.trim();if(q.length<2)return;
    /* The search words ride after the # so they are never sent to the web host. */
    location.href=base+'jobs/#find='+encodeURIComponent(q);
    if(here==='jobs')e.target.q.value='';
  });

  window.AppShell={
    set(u){
      user=u&&['admin','csr','tech','stock'].includes(u.role)?{display_name:u.display_name||'',email:u.email||'',role:u.role,manager:!!u.manager,senior:!!u.senior}:null;
      try{user?localStorage.setItem(KEY,JSON.stringify(user)):localStorage.removeItem(KEY)}catch(e){}
      draw();
    },
    user:()=>user
  };
  function mount(){
    if(bar)document.body.prepend(bar);
    document.body.append(side,scrim,tabs);
    /* Show the menu straight away for someone who was signed in on this device; the page confirms a moment later. */
    try{const c=JSON.parse(localStorage.getItem(KEY)||'null');if(c&&c.role){user=c;draw()}}catch(e){}
  }
  if(document.body)mount();else document.addEventListener('DOMContentLoaded',mount);
})();
