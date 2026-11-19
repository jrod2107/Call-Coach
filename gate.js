/* gate.js: the sign-in screen for pages whose content is kept out of the web host.

   A page file on the host can be read by anyone who has its address. So a page that carries business details
   (fees, scripts, rules) keeps only its styles and this sign-in screen on the host. Its real content lives in the
   database table protected_pages and is handed over only after a staff sign-in, by row-level security.

   Use, as the only thing in <body> (the Supabase library and config.js must already be loaded in <head>):
     <script src="../gate.js" data-slug="intake" data-title="Call Intake" data-settings="../settings/" data-link="1"></script>
   data-slug      which protected_pages row to load
   data-link      "1" also offers "Email me a sign-in link"
   data-detect    "0" stops the sign-in library reading the address (for pages another service redirects back to)

   To change a protected page: edit its private content file, then release it (tools/release-protected-page.sh). */
(function(){
  const me=document.currentScript,D=me.dataset,slug=D.slug,title=D.title||'City Appliance',CFG=window.COACH_CONFIG||{};
  const KEY='gate:'+slug;
  const css='#gate{position:fixed;inset:0;z-index:9999;background:#f3f5f7;color:#17212b;display:flex;align-items:center;justify-content:center;padding:16px;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}'
    +'#gate form{background:#fff;border:1px solid #d5dbe1;border-radius:10px;padding:22px;width:min(380px,100%);display:flex;flex-direction:column;gap:12px;box-sizing:border-box}'
    +'#gate h1{font-size:22px;margin:0}#gate p{margin:0;font-size:14px;color:#52606d}'
    +'#gate label{font-size:13px;color:#52606d;display:flex;flex-direction:column;gap:4px}'
    +'#gate input{font:inherit;padding:10px;border:1px solid #c3ccd5;border-radius:6px;background:#fff;color:#17212b}'
    +'#gate button{font:inherit;font-weight:600;padding:11px;border-radius:6px;border:1px solid #1e40af;background:#1e40af;color:#fff;cursor:pointer}'
    +'#gate button.plain{background:none;color:#1e40af;border-color:#c3ccd5}#gate button:disabled{opacity:.5;cursor:default}'
    +'#gate a{font-size:13px;color:#1e40af}#gate-msg{font-size:13px;min-height:18px;color:#9a3412}'
    +'@media (prefers-color-scheme:dark){#gate{background:#111315;color:#e8edf2}#gate form{background:#1a1e22;border-color:#343b43}#gate p,#gate label{color:#a7b3bf}'
    +'#gate input{background:#111315;color:#e8edf2;border-color:#48525c}#gate button.plain,#gate a{color:#8fb4ff}#gate button.plain{border-color:#48525c}#gate-msg{color:#fdba74}}';
  const st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
  const gate=document.createElement('div');gate.id='gate';
  gate.innerHTML='<form id="gate-form"><h1></h1><p>Sign in with your City Appliance email and password.</p>'
    +'<label>Email<input type="email" id="gate-email" autocomplete="username" required></label>'
    +'<label>Password<input type="password" id="gate-pass" autocomplete="current-password"></label>'
    +'<button type="submit">Sign in</button>'
    +(D.link==='1'?'<button type="button" class="plain" id="gate-link">Email me a sign-in link</button>':'')
    +'<div id="gate-msg" role="status"></div>'
    +(D.settings?'<a id="gate-forgot">Forgot your password?</a>':'')+'</form>';
  gate.querySelector('h1').textContent=title;
  if(D.settings)gate.querySelector('#gate-forgot').href=D.settings;
  document.body.appendChild(gate);
  const form=gate.querySelector('form'),msg=gate.querySelector('#gate-msg'),$=id=>gate.querySelector('#'+id);
  const say=t=>{msg.textContent=t},lock=on=>form.querySelectorAll('input,button').forEach(e=>{e.disabled=on});
  if(!slug||!window.supabase||!CFG.supabaseUrl){say('Setup problem: the sign-in could not load. Reload the page.');lock(true);return}
  const sb=window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey,D.detect==='0'?{auth:{detectSessionInUrl:false}}:undefined);
  const cached=()=>{try{const c=JSON.parse(localStorage.getItem(KEY)||'null');return c&&typeof c.html==='string'?c:null}catch(e){return null}};

  /* Scripts that arrive as text do not run by themselves. Run each one in page order, waiting for files to load. */
  async function show(html){
    try{sb.auth.stopAutoRefresh()}catch(e){}   /* the page makes its own client from here on */
    const t=document.createElement('template');t.innerHTML=html;
    const scripts=Array.from(t.content.querySelectorAll('script'));
    gate.remove();st.remove();
    document.body.appendChild(t.content);
    for(const s of scripts){
      const type=(s.getAttribute('type')||'').toLowerCase();
      if(type&&type!=='module'&&!/^(text|application)\/(x-)?(java|ecma)script$/.test(type))continue;   /* data blocks stay as they are */
      const n=document.createElement('script');
      for(const a of Array.from(s.attributes))n.setAttribute(a.name,a.value);
      if(s.hasAttribute('src')){n.async=false;await new Promise(done=>{n.onload=done;n.onerror=done;s.replaceWith(n)})}
      else{n.textContent=s.textContent;s.replaceWith(n)}
    }
  }
  let opening=false;
  async function open(){
    if(opening)return;opening=true;   /* a password sign-in also raises SIGNED_IN; open once */
    lock(true);say('Opening…');
    let res;try{res=await sb.from('protected_pages').select('html,sha256').eq('slug',slug).maybeSingle()}catch(e){res={error:e}}
    if(res.error){
      /* Could not reach the database. A device that has opened this page before, and is still signed in, keeps working. */
      const c=cached();if(c){show(c.html);return}
      opening=false;lock(false);say('Could not load the page. Check your connection and try again.');return}
    if(!res.data||!res.data.html){
      try{localStorage.removeItem(KEY)}catch(e){}
      form.innerHTML='<h1></h1><p>This account does not have access to this page. Ask Jake to set your role.</p><button type="button" id="gate-out">Sign out</button>';
      form.querySelector('h1').textContent=title;
      form.querySelector('#gate-out').addEventListener('click',async()=>{await sb.auth.signOut();location.reload()});return}
    try{localStorage.setItem(KEY,JSON.stringify({sha:res.data.sha256,html:res.data.html}))}catch(e){}
    show(res.data.html);
  }
  form.addEventListener('submit',async e=>{e.preventDefault();
    if(!$('gate-pass').value){say('Type your password'+(D.link==='1'?', or use the sign-in link button.':'.'));return}
    say('Signing in…');
    const {error}=await sb.auth.signInWithPassword({email:$('gate-email').value.trim(),password:$('gate-pass').value});
    if(error){say(error.message==='Invalid login credentials'?'Wrong email or password.':error.message);return}
    open()});
  if(D.link==='1')$('gate-link').addEventListener('click',async()=>{
    const email=$('gate-email').value.trim();if(!/^\S+@\S+\.\S+$/.test(email)){say('Type your email first.');return}
    say('Sending…');
    const {error}=await sb.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:location.origin+location.pathname}});
    say(error?(/rate|limit|seconds/i.test(error.message)?'Too many emails were sent just now. Wait a few minutes, or use your password.':error.message)
      :'Check your email for a sign-in link. It opens right back up here.')});
  (async()=>{
    let session=null;try{session=(await sb.auth.getSession()).data.session}catch(e){}
    if(session){open();return}
    /* A sign-in link lands here a moment before the library has finished reading it. */
    sb.auth.onAuthStateChange((ev,s)=>{if(s&&ev==='SIGNED_IN'&&document.body.contains(gate))open()});
    $('gate-email').focus();
  })();
})();
