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
     Auth.signOut()                                  ends the sign-in on this device only, then reloads */
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
  window.Auth={client,session,profile,assurance,codeAgeDays,loginForm,signIn,signOut,CODE_DAYS};
})();
