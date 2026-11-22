/* auth.js: the one copy of sign-in, the staff profile and the two-step check that every page shares.

   This file only decides what a page shows. What a person may actually read or change is decided by the
   database (row level security) and the server functions, never here.

   Load it after the Supabase library and config.js, before the page's own script:
     <script src="../auth.js"></script>
   Then, in the page:
     const SB=Auth.client();                         one shared connection, or null when config.js is missing
     S.session=await Auth.session(s=>{S.session=s}); the saved sign-in on this device, kept fresh
     S.me=await Auth.profile(S.session);             the staff profile, or a "pending" stand-in
     Object.assign(S,await Auth.assurance(S.session)); S.aal and S.next for pages that need the 6-digit code
     Auth.loginForm('City Appliance Jobs')           the sign-in form (form id "login", fields lgEmail and lgPass);
                                                     an optional second argument adds HTML at the end of the form
     await Auth.signIn(email,password)               returns {data,error} like the Supabase call
     Auth.signOut()                                  ends the sign-in on this device only, then reloads
     Auth.codeForm(why,base,next)                    the "enter your 6-digit code" card. It checks the code itself and
                                                     reloads the page when it matches. `next` is S.next: when the
                                                     account has no authenticator yet, the card sends them to Jobs
                                                     to set one up. `base` is the path to the site root ("../"). */
(function(){
  if(window.Auth)return;
  const CFG=window.COACH_CONFIG||{};
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  /* Every column any page reads from its own profile row. */
  const COLS='id,display_name,email,role,manager,senior,hcp_employee_id,default_location_id';
  /* The 6-digit code is asked for once every two weeks on each device, not at every visit. */
  const CODE_DAYS=14;
  let sb;

  function client(){
    if(sb!==undefined)return sb;
    sb=(window.supabase&&CFG.supabaseUrl)?window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseAnonKey):null;
    return sb;
  }
  async function session(onChange){
    const c=client();if(!c)return null;
    const {data:{session:s}}=await c.auth.getSession();
    if(onChange)c.auth.onAuthStateChange((ev,n)=>{if(n)onChange(n)});
    return s;
  }
  async function profile(s){
    if(!s)return null;
    const {data}=await client().from('profiles').select(COLS).eq('id',s.user.id).maybeSingle();
    return data||{id:s.user.id,role:'pending',email:s.user.email,display_name:''};
  }
  /* How many days since the code was last entered. The sign-in itself records it. Cannot tell: 0, so nobody is nagged. */
  function codeAgeDays(s){
    try{const p=JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      const t=(p.amr||[]).filter(a=>a&&a.method==='totp').map(a=>Number(a.timestamp)).filter(isFinite).sort((a,b)=>a-b).pop();
      return t?(Date.now()/1000-t)/86400:0}catch(e){return 0}
  }
  /* aal2 means the code has been entered. next tells whether the account has an authenticator set up yet. */
  async function assurance(s){
    const {data}=await client().auth.mfa.getAuthenticatorAssuranceLevel();
    let aal=data?data.currentLevel:null,next=data?data.nextLevel:null;
    if(aal==='aal2'&&s&&codeAgeDays(s)>CODE_DAYS){aal='aal1';next='aal2'}   /* two weeks have passed: ask again */
    return {aal,next};
  }
  function loginForm(title,extra){
    return `<form class="card" id="login"><h2>${esc(title||'City Appliance')}</h2>
  <p class="muted">Sign in with your City Appliance email and password.</p>
  <label class="fld"><span>Email</span><input id="lgEmail" type="email" autocomplete="username" required></label>
  <label class="fld"><span>Password</span><input id="lgPass" type="password" autocomplete="current-password" required></label>
  <button class="primary" type="submit">Sign in</button><div id="lgMsg" class="muted" role="status"></div>${extra||''}</form>`;
  }
  function signIn(email,password){
    return client().auth.signInWithPassword({email:String(email||'').trim(),password});
  }
  async function signOut(){
    try{await client().auth.signOut({scope:'local'})}finally{location.reload()}
  }
  function codeForm(why,base,next){
    const jobs=(base==null?'../':base)+'jobs/';
    if(next&&next!=='aal2')return `<div class="card"><h2>Set up two-step sign-in</h2>
  <p>${esc(why||'This page holds customer details.')} It needs the 6-digit code from an authenticator app, and this account does not have one set up yet. Set it up on the Jobs page, then come back.</p>
  <a class="btn primary" href="${esc(jobs)}">Set it up on Jobs</a></div>`;
    return `<form class="card" id="authCode"><h2>Enter your sign-in code</h2>
  <p>${esc(why||'This page holds customer details.')} Type the 6-digit code from your authenticator app. You enter it once every two weeks on each device.</p>
  <label class="fld"><span>6-digit code</span><input id="authCodeIn" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
  <button class="primary" type="submit">Continue</button><div id="authCodeMsg" class="muted" role="status"></div></form>`;
  }
  async function verify(code){
    const c=client(),lf=await c.auth.mfa.listFactors();
    const f=((lf.data&&lf.data.totp)||[]).find(x=>x.status==='verified');
    if(!f)throw new Error('No authenticator is set up on this account. Set it up on the Jobs page.');
    const {error}=await c.auth.mfa.challengeAndVerify({factorId:f.id,code});
    if(error)throw error;
  }
  document.addEventListener('input',e=>{if(e.target&&e.target.id==='authCodeIn')e.target.value=e.target.value.replace(/\D/g,'').slice(0,6)});
  document.addEventListener('submit',async e=>{
    if(!e.target||e.target.id!=='authCode')return;
    e.preventDefault();e.stopImmediatePropagation();
    const m=document.getElementById('authCodeMsg'),code=(document.getElementById('authCodeIn').value||'').trim();
    if(code.length!==6){m.textContent='Type all 6 digits.';return}
    m.textContent='Checking…';
    try{await verify(code);m.textContent='Done. Opening…';location.reload()}
    catch(err){m.textContent=/invalid|expired/i.test(err.message||'')?'That code did not match. Wait for a new one and try again.':(err.message||String(err))}
  },true);
  window.Auth={client,session,profile,assurance,codeAgeDays,loginForm,signIn,signOut,codeForm,verify,CODE_DAYS};
})();
