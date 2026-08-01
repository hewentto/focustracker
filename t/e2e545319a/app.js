"use strict";

/* GATE_HASH and GATE_SALT come from gate.js. */
const LS_UNLOCK="ft.unlocked.v1";
const LS_DATA="ft.data.v1", LS_PREF="ft.prefs.v1", LS_TOK="ft.tok.v1", LS_GIST="ft.gist.v1", LS_THEME="ft.theme.v1";
const LS_DIRTY="ft.dirty.v1";
const GIST_FILE="focus-tracker-data.json";
const CSV_FILE="focus-log.csv";

/* Core Three first — a bad day that hits these three is a win. */
const KEYS=["wake","light","train","caff","block","log"];
const CORE3=["wake","light","train"];
const NAMES={wake:"Wake ±30m",light:"Morning light",train:"Trained",caff:"Caffeine plan",block:"Both blocks",log:"Logged"};
/* Every user-editable field. Drives dirty-tracking and the emptiness test. */
const FIELDS=KEYS.concat(["wakeT","bedT","focus","trainType","social","protein","note"]);

/* Weekly targets */
const T_LIFT=3, T_RUN=2, T_SOCIAL=2;

let DB={}, CUR=isoDay(new Date()), syncTimer=null;

/* ---------- gate ---------- */
async function sha256(s){
  const buf=await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function mkHash(){
  const v=document.getElementById("gNew").value;
  document.getElementById("gHash").textContent = v ? await sha256(GATE_SALT+v) : "—";
}
async function tryUnlock(){
  const h=await sha256(GATE_SALT+document.getElementById("gPass").value);
  if(h===GATE_HASH){ lsSet(LS_UNLOCK,h); reveal(); }
  else { document.getElementById("gErr").textContent="Not that one."; document.getElementById("gPass").select(); }
}
function lockNow(){
  lsDel(LS_UNLOCK);
  document.getElementById("app").style.display="none";
  document.getElementById("gate").style.display="flex";
  document.getElementById("gPass").value="";
  document.getElementById("gErr").textContent="";
}
function reveal(){
  document.getElementById("gate").style.display="none";
  document.getElementById("app").style.display="block";
  boot();
}

/* ---------- helpers ---------- */
function isoDay(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function dayFromIso(s){const p=s.split("-");return new Date(+p[0],+p[1]-1,+p[2]);}
function fmtDay(s){return dayFromIso(s).toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"});}
function mins(t){if(!t)return null;const p=t.split(":");return (+p[0])*60+(+p[1]);}
function pretty(m){m=((m%1440)+1440)%1440;let h=Math.floor(m/60),x=m%60,ap=h<12?"am":"pm",hh=h%12===0?12:h%12;return hh+":"+String(x).padStart(2,"0")+ap;}
function blank(){return {wake:false,light:false,train:false,caff:false,block:false,log:false,
  wakeT:"",bedT:"",focus:"",trainType:"",social:false,protein:false,note:"",_u:0};}
/* Reading a day must never create it — browsing with Prev/Next used to leave
   an all-false record behind, which then reached the CSV, the gist and the
   adherence maths. Only save() may bring a day into existence. */
function rec(){return DB[CUR]||blank();}
function recW(){if(!DB[CUR])DB[CUR]=blank();return DB[CUR];}
function sleepMins(r){ if(!r||!r.wakeT||!r.bedT)return null; let x=mins(r.wakeT)-mins(r.bedT); if(x<0)x+=1440; return x; }

function hasVal(v){ return v!==null && v!==undefined && v!==""; }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

/* A day carrying no information at all — not a logged rest day, an artefact. */
function isEmpty(r){
  if(!r)return true;
  if(KEYS.some(k=>r[k])||r.social||r.protein)return false;
  return !["wakeT","bedT","focus","trainType","note"].some(f=>hasVal(r[f]));
}
function prune(db){ Object.keys(db).forEach(d=>{ if(isEmpty(db[d]))delete db[d]; }); return db; }

function lsGet(k,f){try{const v=localStorage.getItem(k);return v===null?f:v;}catch(e){return f;}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function lsDel(k){try{localStorage.removeItem(k);}catch(e){}}

function persist(){
  lsSet(LS_DATA, JSON.stringify(DB));
  const p=document.getElementById("savePill");
  p.textContent="saved "+new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  p.className="pill ok";
}
function loadLocal(){ try{ DB=prune(JSON.parse(lsGet(LS_DATA,"{}"))||{}); }catch(e){ DB={}; } }

/* ---------- unsynced-edit tracking ----------
   One _u per day can't express "Garmin set wakeT while I ticked light", so the
   newer whole record used to win and swallow the other side's edits. Remember
   which fields this device changed since its last successful push and re-apply
   them after every merge; drop them once they're upstream. */
function loadDirty(){ try{ return JSON.parse(lsGet(LS_DIRTY,"{}"))||{}; }catch(e){ return {}; } }
function saveDirty(d){ lsSet(LS_DIRTY, JSON.stringify(d)); }
function markDirty(day,before,after){
  const d=loadDirty(), set={}, base=before||blank();
  (d[day]||[]).forEach(f=>set[f]=1);
  FIELDS.forEach(f=>{ if(base[f]!==after[f])set[f]=1; });
  const list=Object.keys(set);
  if(list.length){ d[day]=list; saveDirty(d); }
}
function dropDirty(sent){
  const d=loadDirty();
  Object.keys(sent).forEach(day=>{
    if(!d[day])return;
    const gone={}; sent[day].forEach(f=>gone[f]=1);
    const left=d[day].filter(f=>!gone[f]);
    if(left.length)d[day]=left; else delete d[day];
  });
  saveDirty(d);
}
function savePrefs(){
  lsSet(LS_PREF, JSON.stringify({
    dose:document.getElementById("cDose").value, time:document.getElementById("cTime").value,
    bed:document.getElementById("cBed").value, half:document.getElementById("cHalf").value
  }));
}
function loadPrefs(){
  try{
    const p=JSON.parse(lsGet(LS_PREF,"null")); if(!p)return;
    if(p.dose)document.getElementById("cDose").value=p.dose;
    if(p.time)document.getElementById("cTime").value=p.time;
    if(p.bed)document.getElementById("cBed").value=p.bed;
    if(p.half)document.getElementById("cHalf").value=p.half;
  }catch(e){}
}

/* ---------- ui ---------- */
function toggleWhy(el){el.parentElement.parentElement.classList.toggle("open");}
function toggleTheme(){
  const r=document.documentElement;
  const next=r.getAttribute("data-theme")==="dark"?"light":"dark";
  r.setAttribute("data-theme",next); lsSet(LS_THEME,next);
}
function shiftDay(n){const d=dayFromIso(CUR);d.setDate(d.getDate()+n);CUR=isoDay(d);loadDay();render();}
function goToday(){CUR=isoDay(new Date());loadDay();render();}

function save(){
  const before=DB[CUR]?Object.assign({},DB[CUR]):null;
  const day=CUR, t=recW();
  document.querySelectorAll('.item input[type=checkbox]').forEach(cb=>{t[cb.dataset.k]=cb.checked;});
  t.wakeT=document.getElementById("fWake").value;
  t.bedT=document.getElementById("fBed").value;
  t.focus=document.getElementById("fFocus").value;
  t.trainType=document.getElementById("fTrain").value;
  t.social=document.getElementById("fSocial").checked;
  t.protein=document.getElementById("fProtein").checked;
  t.note=document.getElementById("fNote").value;
  t._u=Date.now();
  markDirty(day,before,t);
  if(isEmpty(t))delete DB[day];
  persist(); render(); queueSync();
}
function loadDay(){
  const t=rec();
  document.querySelectorAll('.item input[type=checkbox]').forEach(cb=>{cb.checked=!!t[cb.dataset.k];});
  document.getElementById("fWake").value=t.wakeT||"";
  document.getElementById("fBed").value=t.bedT||"";
  document.getElementById("fFocus").value=t.focus||"";
  document.getElementById("fTrain").value=t.trainType||"";
  document.getElementById("fSocial").checked=!!t.social;
  document.getElementById("fProtein").checked=!!t.protein;
  document.getElementById("fNote").value=t.note||"";
  document.getElementById("todayLabel").textContent=fmtDay(CUR)+(CUR===isoDay(new Date())?" (today)":"");
}

/* ---------- caffeine ---------- */
function calcCaff(){
  const dose=+document.getElementById("cDose").value||0;
  const tk=mins(document.getElementById("cTime").value);
  const bd=mins(document.getElementById("cBed").value);
  const hl=+document.getElementById("cHalf").value;
  if(tk===null||bd===null||!dose)return;
  let elapsed=bd-tk; if(elapsed<0)elapsed+=1440;
  const frac=Math.pow(0.5,(elapsed/60)/hl);
  document.getElementById("cMg").textContent=(dose*frac).toFixed(0)+" mg";
  document.getElementById("cPct").textContent=(frac*100).toFixed(0)+"%";
  const cutoffH=4.54+0.0398*dose;
  const latest=bd-Math.round(cutoffH*60);
  document.getElementById("cCut").textContent=pretty(latest);
  const overBy=(cutoffH*60)-elapsed;
  const okDose=Math.max(0,Math.round((elapsed/60-4.54)/0.0398));
  const v=document.getElementById("cVerdict"); v.className="verdict";
  let cls,t,d;
  if(overBy<=0){ cls="v-good"; t="Inside the modelled window";
    d="Clear by "+Math.round(-overBy)+" min. Ignores guarana's unlabelled caffeine — keep margin."; }
  else if(overBy<=60){ cls="v-warn"; t="Marginal — about "+Math.round(overBy)+" min late";
    d="Move it "+Math.round(overBy)+" min earlier, or drop to ~"+okDose+" mg. Lower dose keeps nearly all the evidenced benefit."; }
  else { cls="v-crit"; t="About "+(overBy/60).toFixed(1)+"h too late";
    d="At this dose you'd need it by "+pretty(latest)+", or cut to ~"+okDose+" mg. Drake et al.: 400 mg six hours pre-bed cost >1h of sleep objectively, with no self-reported signal."; }
  v.classList.add(cls);
  document.getElementById("cvT").textContent=t;
  document.getElementById("cvD").textContent=d;
}

/* ---------- week ---------- */
function weekDays(){const out=[],now=dayFromIso(CUR);for(let i=6;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);out.push(isoDay(d));}return out;}

function tile(id,val,target){
  const el=document.getElementById(id); if(!el)return;
  el.textContent = target===null ? val : val+"/"+target;
  el.style.color = target===null ? "" : (val>=target ? "var(--good)" : "");
}

function render(){
  const days=weekDays(), todayIso=isoDay(new Date());
  document.getElementById("wkHead").innerHTML='<th class="rowh">Behaviour</th>'+days.map(d=>{
    const dd=dayFromIso(d);
    return '<th'+(d===CUR?' class="today"':'')+'>'+dd.toLocaleDateString(undefined,{weekday:"short"})+'<br><span style="font-weight:400;opacity:.7">'+(dd.getMonth()+1)+"/"+dd.getDate()+'</span></th>';
  }).join("");

  let html="";
  KEYS.forEach(k=>{
    const core=CORE3.indexOf(k)>=0;
    html+='<tr><td class="rowh">'+(core?'<span class="core-dot" title="Core Three"></span>':'')+NAMES[k]+"</td>";
    days.forEach((d,i)=>{
      const r=DB[d], done=r&&r[k];
      let flag=false;
      if(!done && i>0 && d<=todayIso){const p=DB[days[i-1]]; if(p&&!p[k])flag=true;}
      html+='<td'+(d===CUR?' class="today"':'')+'><span class="cell '+(done?"yes":"")+(flag?" flag":"")+'" title="'+NAMES[k]+" — "+d+'">'+(done?"✓":(flag?"!":"–"))+"</span></td>";
    });
    html+="</tr>";
  });
  html+='<tr><td class="rowh">Session</td>';
  days.forEach(d=>{
    const r=DB[d]; const tt=r&&r.trainType?r.trainType:"";
    const lbl={lift:"Lift",run:"Run",snack:"Snack",other:"Other"}[tt]||"—";
    html+='<td'+(d===CUR?' class="today"':'')+'><span style="font-size:11.5px;color:var(--text-secondary)">'+lbl+"</span></td>";
  });
  html+="</tr><tr><td class=\"rowh\">Sleep window</td>";
  days.forEach(d=>{
    const r=DB[d]; const sm=sleepMins(r);
    let inner = sm===null ? '<span style="color:var(--text-muted)">—</span>'
      : '<span style="font-size:11.5px;color:var(--text-secondary)">'+(sm/60).toFixed(1)+"h<br>↑"+esc(r.wakeT)+"</span>";
    html+='<td'+(d===CUR?' class="today"':'')+">"+inner+"</td>";
  });
  html+="</tr>";
  document.getElementById("wkBody").innerHTML=html;

  /* --- weekly target tiles --- */
  let lifts=0,runs=0,social=0,core3=0,logged=0;
  days.forEach(d=>{
    const r=DB[d]; if(!r)return;
    if(r.trainType==="lift")lifts++;
    if(r.trainType==="run")runs++;
    if(r.social)social++;
    if(d<=todayIso){ logged++; if(CORE3.every(k=>r[k]))core3++; }
  });
  tile("tLift",lifts,T_LIFT);
  tile("tRun",runs,T_RUN);
  tile("tSocial",social,T_SOCIAL);
  tile("tCore",core3,null);
  document.getElementById("tCore").textContent=core3+"/7";

  /* --- sleep regularity --- */
  const wakes=days.map(d=>DB[d]&&DB[d].wakeT?mins(DB[d].wakeT):null).filter(v=>v!==null);
  let spread=null;
  if(wakes.length>=2){spread=Math.max(...wakes)-Math.min(...wakes);document.getElementById("sWakeSpread").textContent=spread+"m";}
  else document.getElementById("sWakeSpread").textContent="—";

  const durs=days.map(d=>sleepMins(DB[d])).filter(v=>v!==null);
  document.getElementById("sSleep").textContent=durs.length?(durs.reduce((a,b)=>a+b,0)/durs.length/60).toFixed(1)+"h":"—";

  let hit=0,poss=0;
  days.forEach(d=>{if(d>todayIso)return;const r=DB[d];if(!r)return;KEYS.forEach(k=>{poss++;if(r[k])hit++;});});
  document.getElementById("sAdh").textContent=poss?Math.round(hit/poss*100)+"%":"—";

  const fs=days.map(d=>DB[d]&&DB[d].focus?+DB[d].focus:null).filter(v=>v!==null&&!isNaN(v));
  document.getElementById("sFocus").textContent=fs.length?Math.round(fs.reduce((a,b)=>a+b,0)/fs.length)+"m":"—";

  const rv=document.getElementById("rVerdict"); rv.className="verdict";
  let c,t,dsc;
  if(spread===null){c="v-warn";t="Not enough wake-time data yet";dsc="Log wake time on at least two days. Regularity is the variable worth watching — your duration is already in range.";}
  else if(spread<=30){c="v-good";t="Wake time is anchored ("+spread+" min spread)";dsc="This is the state the regularity literature associates with better outcomes — and it's the gate on whether the 6/7am gym session happens. Hold it at weekends too.";}
  else if(spread<=75){c="v-warn";t="Wake time drifting ("+spread+" min spread)";dsc="Aim for under 30 min. Phillips et al. 2017: irregular sleepers with identical total sleep time still had melatonin onset ~2.6h later. Phase, not duration.";}
  else {c="v-crit";t="Wake time is highly variable ("+spread+" min spread)";dsc="A "+spread+"-minute spread re-sets your circadian phase most days — and it's the reason the early sessions don't happen. Fixable without sleeping more.";}
  rv.classList.add(c);
  document.getElementById("rvT").textContent=t;
  document.getElementById("rvD").textContent=dsc;
}

/* ---------- CSV ---------- */
function csvEsc(s){ s=String(s==null?"":s); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }
function toCSV(){
  const hdr=["date","wake_within_30m","morning_light","trained","caffeine_plan","both_blocks","logged",
             "core3_all","training_type","wake_time","bed_time","sleep_hours","longest_block_min",
             "social_contact","protein_target","note"];
  const rows=Object.keys(DB).sort().map(d=>{
    const r=DB[d]||{}; const sm=sleepMins(r);
    return [d, r.wake?1:0, r.light?1:0, r.train?1:0, r.caff?1:0, r.block?1:0, r.log?1:0,
            CORE3.every(k=>r[k])?1:0, r.trainType||"",
            r.wakeT||"", r.bedT||"", sm===null?"":(sm/60).toFixed(2), r.focus||"",
            r.social?1:0, r.protein?1:0,
            r.note||""].map(csvEsc).join(",");
  });
  return hdr.join(",")+"\n"+rows.join("\n")+"\n";
}
function downloadCSV(){
  const blob=new Blob([toCSV()],{type:"text/csv;charset=utf-8"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url; a.download="best-jared-"+isoDay(new Date())+".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  msg("CSV downloaded — "+Object.keys(DB).length+" day(s).");
}

/* ---------- merge + gist sync ---------- */
/* Newest edit still wins the day, but field by field rather than wholesale —
   and anything this device changed and hasn't pushed yet survives regardless,
   so the 08:20 Garmin job can no longer swallow an unsynced tick or note. */
function merge(local,remote,dirty){
  dirty=dirty||{};
  const out={};
  Object.keys(local).forEach(k=>out[k]=local[k]);
  Object.keys(remote).forEach(day=>{
    const mine=out[day], theirs=remote[day];
    if(!mine){ out[day]=theirs; return; }
    const theirsNewer=(theirs._u||0)>(mine._u||0);
    const merged=Object.assign({}, theirsNewer?mine:theirs, theirsNewer?theirs:mine);
    (dirty[day]||[]).forEach(f=>{ if(f in mine)merged[f]=mine[f]; });
    merged._u=Math.max(mine._u||0, theirs._u||0);
    out[day]=merged;
  });
  return out;
}
function setPill(el,txt,cls){const p=document.getElementById(el);p.textContent=txt;p.className="pill"+(cls?" "+cls:"");}
function msg(t){document.getElementById("syncMsg").textContent=t||"";}

async function gh(path,opts,tok){
  const r=await fetch("https://api.github.com"+path, Object.assign({
    headers:{ "Authorization":"Bearer "+tok, "Accept":"application/vnd.github+json", "X-GitHub-Api-Version":"2022-11-28" }
  },opts||{}));
  if(!r.ok){ let detail=""; try{ detail=(await r.json()).message||""; }catch(e){}
    throw new Error("GitHub "+r.status+(detail?" — "+detail:"")); }
  return r.json();
}
function gistPayload(){
  return { [GIST_FILE]:{content:JSON.stringify({v:2,data:DB},null,1)},
           [CSV_FILE]:{content:toCSV()} };
}
function queueSync(){
  if(!lsGet(LS_TOK,"")||!lsGet(LS_GIST,""))return;
  clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>syncNow(true),4000);
}
async function syncNow(quiet){
  const tokIn=document.getElementById("ghTok").value.trim();
  const gidIn=document.getElementById("ghGist").value.trim();
  if(tokIn){ lsSet(LS_TOK,tokIn); document.getElementById("ghTok").value=""; }
  if(gidIn){ lsSet(LS_GIST,gidIn); }
  const tok=lsGet(LS_TOK,""); let gid=lsGet(LS_GIST,"");
  if(!tok){ setPill("syncPill","not configured",""); msg("Paste a token first, or keep local-only saving plus Download CSV."); return; }

  setPill("syncPill","syncing…","busy"); if(!quiet)msg("");
  document.getElementById("btnSync").disabled=true;
  try{
    if(gid){
      const g=await gh("/gists/"+gid,null,tok);
      const f=g.files&&g.files[GIST_FILE];
      if(f&&f.content){
        let remote={}; try{ remote=JSON.parse(f.content).data||{}; }catch(e){}
        DB=prune(merge(DB,remote,loadDirty())); persist(); loadDay(); render();
      }
      /* Snapshot first: edits made while the PATCH is in flight stay dirty. */
      const sent=loadDirty();
      await gh("/gists/"+gid,{method:"PATCH",body:JSON.stringify({files:gistPayload()})},tok);
      dropDirty(sent);
    }else{
      const sent=loadDirty();
      const g=await gh("/gists",{method:"POST",body:JSON.stringify({
        description:"Building the Best Jared — private log", public:false, files:gistPayload()
      })},tok);
      dropDirty(sent);
      gid=g.id; lsSet(LS_GIST,gid); document.getElementById("ghGist").value=gid;
      msg("Created secret gist "+gid+" — copy that ID onto your other device.");
    }
    document.getElementById("ghGist").value=lsGet(LS_GIST,"");
    setPill("syncPill","synced "+new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),"ok");
  }catch(e){
    setPill("syncPill","sync failed","err");
    msg(e.message+". A 401/403 means the token is wrong, expired, or missing Gists: Read and write.");
  }finally{ document.getElementById("btnSync").disabled=false; }
}
function forgetToken(){
  lsDel(LS_TOK); document.getElementById("ghTok").value="";
  setPill("syncPill","not configured","");
  msg("Token removed from this device. Log still saved locally; gist untouched.");
}
function openGist(){
  const gid=lsGet(LS_GIST,"");
  if(!gid){ msg("No gist yet — sync once to create it."); return; }
  window.open("https://gist.github.com/"+gid,"_blank","noopener");
}

/* ---------- export / import ---------- */
function exportData(){
  const box=document.getElementById("ioBox");
  box.value=JSON.stringify({v:2,data:DB}); box.select();
  try{document.execCommand("copy");}catch(e){}
  msg("Copied to clipboard.");
}
function importData(){
  const raw=document.getElementById("ioBox").value.trim();
  if(!raw){msg("Paste exported text into the box first.");return;}
  try{
    const o=JSON.parse(raw); if(!o.data)throw 0;
    DB=prune(merge(DB,o.data)); persist(); loadDay(); render();
    msg("Merged "+Object.keys(o.data).length+" day(s).");
  }catch(e){ msg("That doesn't look like exported data."); }
}

/* ---------- boot ---------- */
let booted=false;
function boot(){
  if(booted)return; booted=true;
  loadLocal(); loadPrefs(); loadDay(); calcCaff(); render();
  const gid=lsGet(LS_GIST,""); if(gid)document.getElementById("ghGist").value=gid;
  if(lsGet(LS_TOK,"")){ setPill("syncPill","token saved on this device","ok"); syncNow(true); }
  const n=Object.keys(DB).length;
  const sp=document.getElementById("savePill");
  if(n===0){ sp.textContent="saves automatically"; }
  else { sp.textContent=n+" days logged"; sp.className="pill ok"; }
}

(function(){
  const th=lsGet(LS_THEME,""); if(th)document.documentElement.setAttribute("data-theme",th);
  if(typeof GATE_HASH==="undefined" || !GATE_HASH){ reveal(); return; }
  if(lsGet(LS_UNLOCK,"")===GATE_HASH){ reveal(); return; }
  document.getElementById("gPass").focus();
})();
