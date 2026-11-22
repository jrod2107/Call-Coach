/* Labels to print: one shared list for Stock tags (S0xxxx) and Parts desk tags (P0xxxx).
   Both the Stock page and the Parts desk load this file, show the same list, and print from it.

   A tag is "pending" until someone marks its label printed. Stock parts are pending from the moment they are
   scanned in; job parts are pending once they are received. Sending the labels builds a PDF (one, two or three
   tags per 4 x 6 inch label, or one tag per 2.25 x 1.25 inch label). On a phone or tablet the file is saved so the
   printer's own app (FlashLabel Pro) can open it, because over Bluetooth the Labeer Y43 only listens to that app and
   the Share menu does not list it. On a computer the file opens in a new tab to print over USB with Labeer's driver.

   A page uses it like this:
     Labels.init({SB, me:()=>profile, rerender, toast, query:()=>search text, loc:()=>location id, changed})
     await Labels.load()            when the page loads or refreshes its own data
     Labels.count()                 number of tags waiting, for the tab badge
     Labels.view()                  the list, as HTML, for the tab body
     Labels.select(ids)             tick only these tags
     Labels.selectAll()             tick everything again
     Labels.reprint(kind,id)        put a printed tag back in the list, ticked */
(function(){
'use strict';
const L=window.Labels={};
const KEY='tagLayout';
let cfg={};
const st={rows:[],sel:null,ask:null,err:'',partsErr:''};

const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate=iso=>iso?new Date(String(iso).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
const lastName=n=>String(n||'').trim().split(/\s+/).pop().replace(/[^A-Za-z0-9]/g,'');
const COND={new:'New',open_box:'Open box',used:'Used'};
const role=()=>{const m=cfg.me&&cfg.me();return m?m.role:''};
const canPrint=()=>['csr','admin','stock'].includes(role());   /* technicians can look, not print */
const toast=(m,bad)=>{if(cfg.toast)cfg.toast(m,bad)};

/* ---------- loading ---------- */
const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o};
L.init=o=>{cfg=o||{}};
L.load=async function(){
  const sb=cfg.SB;if(!sb)return;
  st.err='';st.partsErr='';
  const items=[],cat={};let parts=[],locs=[];
  try{
    for(let from=0;;from+=1000){
      const {data,error}=await sb.from('stock_items').select('id,tag,part_number,location_id,bin,condition,created_at').in('status',['in_stock','held']).is('label_printed_at',null).order('created_at').order('id').range(from,from+999);
      if(error)throw error;items.push(...data);if(data.length<1000)break;
    }
    for(const c of chunk([...new Set(items.map(i=>i.part_number))],150)){
      const {data,error}=await sb.from('stock_catalog').select('part_number,description,brand').in('part_number',c);
      if(error)throw error;data.forEach(r=>{cat[r.part_number]=r});
    }
    const l=await sb.from('stock_locations').select('id,name');if(l.error)throw l.error;locs=l.data||[];
  }catch(e){st.err=e.message||String(e)}
  try{
    const {data,error}=await sb.from('parts').select('id,tag,job_number,customer_name,part_number,description,qty,po_number,return_by,received_on,created_at,location_id,vendor_other,vendors!parts_vendor_id_fkey(name)').eq('status','received').is('label_printed_at',null).order('received_on').order('id').limit(500);
    if(error)throw error;parts=data||[];
  }catch(e){st.partsErr=e.message||String(e)}
  const locName=id=>(locs.find(l=>l.id===id)||{}).name||'';
  st.rows=[
    ...items.map(i=>{const c=cat[i.part_number]||{};const where=locName(i.location_id)+(i.bin?' / '+i.bin:'');
      return {id:i.id,kind:'stock',what:'Stock',tag:i.tag,right:c.brand||'',pn:i.part_number,desc:c.description||'',
        foot:[where,COND[i.condition],fmtDate(i.created_at)].filter(Boolean).join(' | '),where:where.replace(' / ',' · '),added:i.created_at,loc:i.location_id,
        search:[i.tag,i.part_number,c.description,c.brand].join(' ').toLowerCase()}}),
    ...parts.map(p=>{const v=p.vendor_other||(p.vendors&&p.vendors.name)||'';
      return {id:p.id,kind:'part',what:'Job part',tag:p.tag,right:'#'+p.job_number+' '+lastName(p.customer_name),pn:p.part_number+(p.qty>1?' x'+p.qty:''),desc:p.description||'',
        foot:[v,p.po_number?'PO '+p.po_number:'',p.return_by?'Return by '+fmtDate(p.return_by):''].filter(Boolean).join(' | '),
        where:'Job #'+p.job_number+(p.customer_name?' · '+p.customer_name:''),added:p.received_on||p.created_at,loc:p.location_id,
        search:[p.tag,p.part_number,p.description,p.job_number,p.customer_name].join(' ').toLowerCase()}})
  ].sort((a,b)=>String(a.added).localeCompare(String(b.added))||a.tag.localeCompare(b.tag));
  if(st.sel)st.sel=new Set([...st.sel].filter(id=>st.rows.some(r=>r.id===id)));
};
L.count=()=>st.rows.length;
L.rows=()=>st.rows.slice();
L.select=ids=>{st.sel=new Set(ids);st.ask=null};
L.selectAll=()=>{st.sel=null};

/* The rows on screen: filtered by the page's search box and location. */
const shown=()=>{
  const q=((cfg.query&&cfg.query())||'').trim().toLowerCase(),loc=(cfg.loc&&cfg.loc())||'';
  return st.rows.filter(r=>(!loc||!r.loc||r.loc===loc)&&(!q||r.search.includes(q)));
};
const checked=r=>st.sel?st.sel.has(r.id):true;

/* ---------- the list ---------- */
const tagLayout=()=>{try{const v=localStorage.getItem(KEY);return ['1','2','small'].includes(v)?v:'3'}catch(e){return '3'}};
const layoutSel=()=>`<select id="tag-layout" aria-label="Labels" style="width:auto"><option value="3" ${tagLayout()==='3'?'selected':''}>3 tags per 4x6 label</option><option value="2" ${tagLayout()==='2'?'selected':''}>2 tags per 4x6 label</option><option value="1" ${tagLayout()==='1'?'selected':''}>1 tag per 4x6 label</option><option value="small" ${tagLayout()==='small'?'selected':''}>Small labels, 2.25 x 1.25 (1 per label)</option></select>`;
/* Phones and tablets save the file for FlashLabel Pro (the Labeer printer's app); computers print it.
   The main button is the one that fits the device; the other stays available. */
const touch=()=>{try{return matchMedia('(pointer:coarse)').matches}catch(e){return false}};
const canShareFiles=()=>{try{return !!(navigator.canShare&&navigator.canShare({files:[new File(['x'],'t.pdf',{type:'application/pdf'})]}))}catch(e){return false}};
function sendButtons(n){
  const d=n?'':'disabled',phone=touch();
  const save=`<button ${phone?'class="primary"':''} data-lbl="save" ${d}>Save label file</button>`;
  const print=`<button ${phone?'':'class="primary"'} data-lbl="print" ${d}>Print</button>`;
  const shr=phone&&canShareFiles()?`<button data-lbl="share" ${d}>Share</button>`:'';
  return phone?save+shr+print:print+save;
}
const howTo=()=>`<details style="margin:0 12px 12px"><summary>How to print</summary>
  <p><b>On a phone or tablet:</b> tap Save label file. Open FlashLabel Pro, choose to print a PDF or file, and pick the file you just saved (it is in Downloads or Files, named tags-...). Print it.</p>
  <p><b>On a computer:</b> plug the Labeer printer in with its USB cable and install Labeer's driver once. Click Print, then in the window that opens press Print again (Cmd+P on a Mac, Ctrl+P on Windows). Pick the Labeer printer and the 4 x 6 paper size. For the small labels, pick 2.25 x 1.25.</p>
  <p>When the labels are out, answer Yes so they leave this list.</p></details>`;
L.view=function(){
  const rows=shown(),ed=canPrint(),picked=rows.filter(checked),n=st.ask?st.ask.length:0;
  const warn=(st.err?`<div class="notice bad" style="margin:12px">Could not load the stock tags: ${esc(st.err)}</div>`:'')+
    (st.partsErr?`<div class="notice bad" style="margin:12px">Could not load the job part tags: ${esc(st.partsErr)}</div>`:'');
  const ask=n?`<div class="notice info" style="margin:12px">Did ${n===1?'the label':'the '+n+' labels'} come out of the printer? <button class="primary small" data-lbl="yes">Yes, mark ${n===1?'it':'them'} printed</button> <button class="small" data-lbl="no">Not yet, keep ${n===1?'it':'them'} in the list</button></div>`:'';
  if(!rows.length)return warn+ask+`<div class="empty">${cfg.loading&&cfg.loading()?'Loading…':'No labels are waiting to be printed. Stock parts show up here when they are scanned in, and job parts when they are received.'}</div>`;
  const bar=ed?`<div class="row" style="padding:12px;align-items:center;flex-wrap:wrap"><span><b>${picked.length}</b> of ${rows.length} selected</span>
    <button class="small" data-lbl="all">Select all</button><button class="small" data-lbl="none">Select none</button><span class="grow"></span>
    ${layoutSel()}${sendButtons(picked.length)}
    <button data-lbl="mark" ${picked.length?'':'disabled'}>Mark as printed</button></div>${howTo()}`
   :`<div class="notice info" style="margin:12px">These tags are waiting to be printed. The office and the stock helper print them.</div>`;
  return warn+ask+bar+`<div class="scroll"><table><thead><tr>${ed?'<th></th>':''}<th>Tag</th><th>Part</th><th>Goes with</th><th>Added</th></tr></thead><tbody>
   ${rows.map(r=>`<tr>${ed?`<td><input type="checkbox" style="width:auto;min-width:24px;min-height:24px" data-lbl-check="${esc(r.id)}" ${checked(r)?'checked':''} aria-label="Select ${esc(r.tag)}"></td>`:''}
    <td class="mono">${esc(r.tag)}<br><span class="muted">${esc(r.what)}</span></td>
    <td><span class="mono">${esc(r.pn)}</span><br><span class="muted">${esc([r.right&&r.kind==='stock'?r.right:'',r.desc].filter(Boolean).join(' · ')||'No name yet')}</span></td>
    <td>${esc(r.where)}</td><td>${fmtDate(r.added)}</td></tr>`).join('')}</tbody></table></div>`;
};

/* ---------- marking printed, and printing again ---------- */
async function markPrinted(ids){
  if(!ids.length)return;
  const sb=cfg.SB,when=new Date().toISOString(),kind=id=>(st.rows.find(r=>r.id===id)||{}).kind;
  const stockIds=ids.filter(id=>kind(id)==='stock'),partIds=ids.filter(id=>kind(id)==='part'),errs=[];
  if(stockIds.length){const {error}=await sb.from('stock_items').update({label_printed_at:when}).in('id',stockIds);if(error)errs.push(error.message)}
  if(partIds.length){const {error}=await sb.from('parts').update({label_printed_at:when}).in('id',partIds);if(error)errs.push(error.message)}
  if(errs.length)toast(errs.join(' '),true);else toast(ids.length===1?'Marked as printed.':ids.length+' labels marked as printed.');
  st.sel=null;await L.load();if(cfg.rerender)cfg.rerender();if(cfg.changed)cfg.changed();
}
/* kind is 'stock' or 'part'. Returns true when the tag is back in the list and ticked. */
L.reprint=async(kind,id)=>{
  const {error}=await cfg.SB.from(kind==='part'?'parts':'stock_items').update({label_printed_at:null}).eq('id',id);
  if(error){toast(error.message,true);return false}
  await L.load();L.select([id]);return true;
};

/* ---------- the PDF ---------- */
/* Width of each character, in thousandths of the font size, for the PDF's built-in Helvetica and Helvetica-Bold (space to ~). */
const HELV=[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB=[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const pdfText=s=>String(s==null?'':s).replace(/·/g,'-').replace(/[^\x20-\x7e]/g,'-');
const pdfEsc=s=>s.replace(/[\\()]/g,'\\$&');
const textW=(s,size,bold)=>{const t=bold?HELVB:HELV;let w=0;for(const ch of s){const v=t[ch.charCodeAt(0)-32];w+=(v==null?556:v)}return w*size/1000};
const fitText=(s,size,bold,maxW)=>{s=pdfText(s);if(textW(s,size,bold)<=maxW)return s;while(s.length>1&&textW(s+'..',size,bold)>maxW)s=s.slice(0,-1);return s.trim()+'..'};
function barBits(text){
  const o={};
  try{window.JsBarcode(o,text,{format:'CODE128'})}catch(e){return ''}
  return (o.encodings&&o.encodings[0]&&o.encodings[0].data)||'';
}
/* Sizes in points for one tag. tagStyle(1) fits a 4 x 2 inch slot; SMALL_STYLE fits a 2.25 x 1.25 inch label. */
const tagStyle=f=>({m:10,top:10*f,tag:18*f,brand:11*f,pn:14*f,desc:10*f,foot:8*f,bh:42*f,l1:17*f,l2:13*f,gap:6*f,l3:11*f,gapx:8*f});
const SMALL_STYLE={m:6,top:4,tag:10,brand:7,pn:9,desc:7.5,foot:6,bh:28,l1:10.5,l2:9,gap:3,l3:7.5,gapx:5};
/* One tag (a row) drawn into the box with its lower-left corner at (x0,yb), sized by s. */
function tagPdf(r,x0,yb,w,h,s){
  const L0=x0+s.m,R=x0+w-s.m,aw=w-2*s.m,out=[];
  const T=(font,size,x,y,t)=>out.push('BT /'+font+' '+size.toFixed(1)+' Tf '+x.toFixed(1)+' '+y.toFixed(1)+' Td ('+pdfEsc(t)+') Tj ET');
  let y=yb+h-s.top-s.tag;
  const tag=pdfText(r.tag);T('F2',s.tag,L0,y,tag);
  const bw=aw-textW(tag,s.tag,true)-s.gapx;
  const right=bw>0?fitText(r.right,s.brand,true,bw):'';
  if(right)T('F2',s.brand,R-textW(right,s.brand,true),y,right);
  y-=s.l1;
  let pn=pdfText(r.pn);while(pn.length>1&&pn.length*0.6*s.pn>aw)pn=pn.slice(0,-1);
  T('F3',s.pn,L0,y,pn);
  y-=s.l2;
  T('F1',s.desc,L0,y,fitText(r.desc,s.desc,false,aw));
  y-=s.gap;
  const bits=barBits(r.tag),bh=s.bh;
  if(bits){
    /* Whole printer dots per bar width (203 dots per inch) so the bars stay sharp and scan reliably. */
    const mw=Math.max(1,Math.floor(aw*203/72/bits.length))*72/203,bx=x0+(w-mw*bits.length)/2;
    let d='',i=0;
    while(i<bits.length){if(bits[i]==='1'){let j=i;while(j<bits.length&&bits[j]==='1')j++;d+=(bx+i*mw).toFixed(2)+' '+(y-bh).toFixed(2)+' '+((j-i)*mw).toFixed(2)+' '+bh.toFixed(2)+' re\n';i=j}else i++}
    out.push(d+'f');
  }
  y-=bh+s.l3;
  T('F1',s.foot,L0,y,fitText(r.foot,s.foot,false,aw));
  return out.join('\n')+'\n';
}
/* mode: '3', '2' or '1' tags per 4 x 6 label, or 'small' for one tag per 2.25 x 1.25 inch label. */
L.buildPdf=function(list,mode){
  const small=mode==='small',slots=small?1:(mode==='1'||mode==='2'?+mode:3);
  const W=small?162:288,H=small?90:432,sh=H/slots,s=small?SMALL_STYLE:tagStyle(slots===3?1:1.5),pages=[];
  for(let i=0;i<list.length;i+=slots){
    let c='';
    for(let k=0;k<slots&&i+k<list.length;k++)c+=tagPdf(list[i+k],0,H-(k+1)*sh,W,sh,s);
    /* Light dashed lines to cut along between the tags. */
    if(slots>1)c+='q 0.5 w 0.6 G [4 3] 0 d '+Array.from({length:slots-1},(_,k)=>'0 '+(H-(k+1)*sh)+' m '+W+' '+(H-(k+1)*sh)+' l S').join(' ')+' Q\n';
    pages.push(c);
  }
  const objs=['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids ['+pages.map((_,i)=>(6+2*i)+' 0 R').join(' ')+'] /Count '+pages.length+' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'];
  pages.forEach((c,i)=>{
    objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+W+' '+H+'] /Contents '+(7+2*i)+' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> >>');
    objs.push('<< /Length '+c.length+' >>\nstream\n'+c+'endstream');
  });
  let out='%PDF-1.4\n';const offs=[];
  objs.forEach((o,i)=>{offs.push(out.length);out+=(i+1)+' 0 obj\n'+o+'\nendobj\n'});
  const xref=out.length;
  out+='xref\n0 '+(objs.length+1)+'\n0000000000 65535 f \n'+offs.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
  out+='trailer\n<< /Size '+(objs.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
  return new Blob([out],{type:'application/pdf'});
};
/* how: 'save' downloads the file, 'print' opens it in a new tab to print, 'share' opens the Share menu.
   Returns true once the file has gone somewhere, false if nothing was sent. */
async function send(list,how){
  if(!list.length)return false;
  const sel=document.getElementById('tag-layout'),mode=sel?sel.value:tagLayout();
  try{localStorage.setItem(KEY,mode)}catch(e){}
  let blob;try{blob=L.buildPdf(list,mode)}catch(e){toast('Could not make the labels: '+e.message,true);return false}
  const name='tags-'+list[0].tag+(list.length>1?'-and-'+(list.length-1)+'-more':'')+'.pdf';
  const url=URL.createObjectURL(blob);
  setTimeout(()=>URL.revokeObjectURL(url),120000);
  if(how==='print'){
    const w=window.open(url,'_blank');
    if(w){toast('The labels opened in a new tab. Press Print there and pick the Labeer printer.');return true}
    how='save';   /* pop-up blocked: save the file instead */
  }
  if(how==='share'){
    const file=new File([blob],name,{type:'application/pdf'});
    try{await navigator.share({files:[file],title:'Labels to print'});return true}
    catch(e){if(e.name==='AbortError'){toast('Nothing was shared. Use Save label file, then open it in FlashLabel Pro.');return false}}
  }
  const a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  toast('Saved '+name+'. Open FlashLabel Pro and print this file.');
  return true;
}

/* ---------- clicks on the list ---------- */
document.addEventListener('click',async e=>{
  const el=e.target.closest('[data-lbl]');if(!el)return;
  const a=el.dataset.lbl,rerender=()=>{if(cfg.rerender)cfg.rerender()};
  if(a==='all'){st.sel=null;rerender()}
  else if(a==='none'){st.sel=new Set();rerender()}
  else if(a==='no'){st.ask=null;rerender()}
  else if(a==='yes'){const ids=st.ask||[];st.ask=null;await markPrinted(ids)}
  else if(a==='mark'){const ids=shown().filter(checked).map(r=>r.id);await markPrinted(ids)}
  else if(a==='save'||a==='print'||a==='share'){
    const list=shown().filter(checked);if(!list.length)return;
    if(await send(list,a)){st.ask=list.map(r=>r.id);st.sel=null;rerender()}
  }
});
document.addEventListener('change',e=>{
  const el=e.target;
  if(el.id==='tag-layout'){try{localStorage.setItem(KEY,el.value)}catch(x){}return}
  if(el.dataset&&el.dataset.lblCheck){
    if(!st.sel)st.sel=new Set(shown().map(r=>r.id));
    if(el.checked)st.sel.add(el.dataset.lblCheck);else st.sel.delete(el.dataset.lblCheck);
    if(cfg.rerender)cfg.rerender();
  }
});
})();
