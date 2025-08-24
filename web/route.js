"use strict";

const CONFIG = window.CONFIG || {};
const MAINTENANCE_MODE = Boolean(CONFIG.MAINTENANCE_MODE);
const MAINTENANCE_KEY = CONFIG.MAINTENANCE_KEY || "";
const USE_ORS_REVERSE = Boolean(CONFIG.USE_ORS_REVERSE);
const appEl=document.getElementById("app");
const maintenanceEl=document.getElementById("maintenance");
if(MAINTENANCE_MODE && MAINTENANCE_KEY){
  const saved=localStorage.getItem("maintenanceKey");
  if(saved===MAINTENANCE_KEY){
    appEl.classList.remove("hidden");
  }else{
    maintenanceEl.classList.remove("hidden");
    document.getElementById("btnMaintenance").addEventListener("click",()=>{
      const val=document.getElementById("maintenanceKey").value.trim();
      if(val===MAINTENANCE_KEY){
        localStorage.setItem("maintenanceKey",val);
        maintenanceEl.classList.add("hidden");
        appEl.classList.remove("hidden");
      }
    });
  }
}else{
  appEl.classList.remove("hidden");
}

const radiusOptions=[5,10,20];
const stepOptions=[5,10,20];
let rKm = Number(CONFIG.SEARCH_RADIUS_KM) || 10;
let stepKm = Number(CONFIG.STEP_KM) || 10;
// Alle Nominatim-Anfragen werden über einen Proxy geleitet,
// daher sind keine speziellen Header mehr nötig.
// Kategorien vorerst deaktiviert
// const categoryMap = {};

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

// Map
const map = L.map('map').setView([48.7, 9.18], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap'}).addTo(map);
let routeLayer;
const resultMarkers = L.layerGroup().addTo(map);

// Shorthands
const $=sel=>document.querySelector(sel);
const startGroup=$("#grpStart"), zielGroup=$("#grpZiel"), queryGroup=$("#grpQuery"), priceGroup=$("#grpPrice"), settingsGroup=$("#grpSettings"), runGroup=$("#grpRun"), resetGroup=$("#grpReset"), mapBox=$("#map-box"), resultsBox=$("#results");
const radiusInput=$("#radius"), stepInput=$("#step"), radiusVal=$("#radiusVal"), stepVal=$("#stepVal"), rateLimitInfo=$("#rateLimitInfo"), priceMinInput=$("#priceMin"), priceMaxInput=$("#priceMax");
const radiusIdx=radiusOptions.indexOf(rKm);
radiusInput.value=radiusIdx>=0?radiusIdx:1;
radiusVal.textContent=radiusOptions[radiusInput.value];
const stepIdx=stepOptions.indexOf(stepKm);
stepInput.value=stepIdx>=0?stepIdx:1;
stepVal.textContent=stepOptions[stepInput.value];
radiusInput.addEventListener('input',()=>radiusVal.textContent=radiusOptions[radiusInput.value]);
stepInput.addEventListener('input',()=>stepVal.textContent=stepOptions[stepInput.value]);

async function updateRateLimitInfo(){
    try{
      const res=await fetch(`/ors/geocode/autocomplete?text=Berlin&boundary.country=DE&size=1`,{headers:{"Accept":"application/json"}});
      const limit=res.headers.get("x-ratelimit-limit");
      const remain=res.headers.get("x-ratelimit-remaining");
      if(limit&&remain){
        rateLimitInfo.textContent=`Rate Limit: ${remain}/${limit}`;
      }else{
        rateLimitInfo.textContent="";
      }
    }catch(err){
      rateLimitInfo.textContent="Rate Limit nicht verfügbar";
    }
  }

  updateRateLimitInfo();

/* Kategorien-Funktion vorerst deaktiviert
async function loadCategories(){
  if(!categorySelect) return;
  categorySelect.innerHTML='<option value="">Alle Kategorien</option>';
  try{
    const cats=await fetch('categories.json').then(r=>r.json());
    cats.forEach(c=>{
      categoryMap[c.id]=c.name;
      const opt=document.createElement('option');
      opt.value=c.id;
      opt.textContent=c.name;
      categorySelect.appendChild(opt);
    });
  }catch(err){
    console.error('Kategorien konnten nicht geladen werden', err);
  }
}
loadCategories();

function extractCategoryId(url){
  const m=url.match(/(\d+)-(\d+)(?:-\d+)?\.html?$/);
  return m?m[2]:null;
}
*/
// Progress-Helfer
function setProgress(pct){
  const bar = $("#progressBar"), txt = $("#progressText");
  const clamped = Math.max(0, Math.min(100, pct|0));
  bar.style.width = clamped + "%";
  txt.textContent = clamped + "%";
}
function setProgressState(state /* 'active' | 'done' | 'aborted' */, msg){
  const bar = $("#progressBar"), txt = $("#progressText");
  bar.classList.remove("active","done","aborted");
  if(state) bar.classList.add(state);
  if(msg) txt.textContent = msg;
}

// -------- Status (nur Konsole) --------
function setStatus(msg,isErr=false){ (isErr?console.error:console.log)(msg); }
function resetStatus(){}

// -------- Ergebnisliste: gruppiert + Galerie --------
const groups = new Map(); // key -> details element

function resultsHeaderHTML(){
  return '<div class="results-header"><strong>Ergebnisliste</strong><button id="btnToggleAll" class="toggle-all" data-state="closed" title="Alle ausklappen">▼</button></div>';
}

function ensureGroup(loc){
  const key=loc||"Unbekannt";
  if(groups.has(key)) return groups.get(key);
  const wrap=document.createElement('details');
  wrap.className='groupbox'; wrap.open=false;
  wrap.innerHTML=`<summary>${escapeHtml(key)} <span class="badge" data-count="0">0</span></summary><div class="gbody"><div class="gallery"></div></div>`;
  resultsBox.appendChild(wrap);
  groups.set(key, wrap);
  return wrap;
}
function clearResults(){
  const r=resultsBox;
  r.innerHTML=resultsHeaderHTML();
  r.dataset.cleared="1";
  resultMarkers.clearLayers();markerClusters.length=0;
  groups.clear();
}
function addResultGalleryGroup(loc, cardHtml){
  const results = resultsBox;
  if(results.dataset.cleared!="1"){
    results.innerHTML=resultsHeaderHTML();
    results.dataset.cleared="1";
  }
  const box=ensureGroup(loc);
  const gallery=box.querySelector('.gallery');
  const frag=document.createDocumentFragment();
  const item=document.createElement('div');
  item.className='gallery-item';
  item.innerHTML=cardHtml;
  frag.appendChild(item);
  gallery.appendChild(frag);
  const badge=box.querySelector('.badge');
  badge.textContent=String(Number(badge.textContent)+1);
}

resultsBox.addEventListener('click', e => {
  if(e.target.id === 'btnToggleAll'){
    const btn = e.target;
    const open = btn.dataset.state !== 'open';
    resultsBox.querySelectorAll('details').forEach(d => d.open = open);
    btn.dataset.state = open ? 'open' : 'closed';
    btn.textContent = open ? '▲' : '▼';
  }
});

function clearInputFields(){
  ['start','ziel','query','priceMin','priceMax'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){ el.value=''; delete el.dataset.lat; delete el.dataset.lon; }
  });
}

$("#btnReset").addEventListener('click', () => {
  clearInputFields();
  runGroup.classList.remove("hidden");
  resetGroup.classList.add("hidden");
  startGroup.classList.remove("hidden");
  zielGroup.classList.remove("hidden");
  queryGroup.classList.remove("hidden");
  priceGroup.classList.remove("hidden");
  settingsGroup.classList.remove("hidden");
  mapBox.classList.add("hidden");
  resultsBox.classList.add("hidden");
  if(routeLayer){ map.removeLayer(routeLayer); routeLayer=null; }
  clearResults();
  setProgress(0);
  setProgressState(null,"0%");
});


// -------- Debounce --------
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}

// -------- Autocomplete --------
function setupSuggest(id){
  const inp=document.getElementById(id);
  const list=document.getElementById(id+"-suggest");
  if(!inp||!list) return;
  const render=items=>{
    list.innerHTML="";
    if(!items.length){ list.hidden=true; return; }
    items.forEach(txt=>{
      const li=document.createElement("li");
      li.textContent=txt;
      li.addEventListener("mousedown",()=>{ inp.value=txt; list.hidden=true; });
      list.appendChild(li);
    });
    list.hidden=false;
  };
  const fetchSuggestions=debounce(async text=>{
    text=text.trim();
    if(!text){ render([]); return; }
    let labels=[];
    try{
      const url=`/ors/geocode/autocomplete?text=${encodeURIComponent(text)}&boundary.country=DE&size=5`;
      const res=await fetch(url,{headers:{"Accept":"application/json"}});
      if(!res.ok) throw new Error("ORS autocomplete failed");
      const j=await res.json();
      labels=j?.features?.map(f=>f.properties.label).filter(Boolean)||[];
    }catch(_){
      try{
        const url=`https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&countrycodes=de&q=${encodeURIComponent(text)}`;
        const j=await fetchJsonViaProxy(url);
        labels=j?.map(r=>r.display_name).filter(Boolean)||[];
      }catch(_){ labels=[]; }
    }
    render(labels);
  },300);
  inp.addEventListener("input",e=>fetchSuggestions(e.target.value));
  inp.addEventListener("blur",()=>setTimeout(()=>list.hidden=true,100));
}

setupSuggest("start");
setupSuggest("ziel");

// -------- Distanz-Helpers --------
function haversine(lat1,lon1,lat2,lon2){
  const R=6371e3, toRad=d=>d*Math.PI/180;
  const φ1=toRad(lat1), φ2=toRad(lat2), dφ=toRad(lat2-lat1), dλ=toRad(lon2-lon1);
  const a=Math.sin(dφ/2)**2+Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// --- Marker-Gruppierung (nahe beieinander) ---
const markerClusters = []; // {lat, lon, marker, items: [html]}
function distMeters(aLat, aLon, bLat, bLon){
  const R=6371e3, toRad=d=>d*Math.PI/180;
  const dφ=toRad(bLat-aLat), dλ=toRad(bLon-aLon);
  const φ1=toRad(aLat), φ2=toRad(bLat);
  const x=Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function addListingToClusters(lat, lon, itemHtml, titleForPopup="Anzeigen in der Nähe"){
  const existing = markerClusters.find(c => distMeters(c.lat,c.lon,lat,lon) < 200); // 200 m
  if(existing){
    existing.items.push(itemHtml);
    const list = `<strong>${titleForPopup}</strong><ul class="preview-list">
      ${existing.items.map(x=>`<li>${x}</li>`).join('')}
    </ul>`;
    existing.marker.setPopupContent(list);
    return existing.marker;
  }else{
    const marker = L.marker([lat,lon],{icon:greenIcon}).addTo(resultMarkers);
    const list = `<strong>${titleForPopup}</strong><ul class="preview-list">
      <li>${itemHtml}</li>
    </ul>`;
    marker.bindPopup(list);
    markerClusters.push({lat,lon,marker,items:[itemHtml]});
    return marker;
  }
}

// ---- Route-Index & Distanzberechnung ----
async function loadRBush(){
  if(window.RBush) return window.RBush;
  await new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/rbush@3.0.1/rbush.min.js';
    s.onload=res; s.onerror=rej; document.head.appendChild(s);
  });
  return window.RBush;
}
function toXY(lat,lon){
  return [lon*111320*Math.cos(lat*Math.PI/180), lat*110540];
}
function distPointSegMeters(lat, lon, seg){
  const [x,y]=toXY(lat,lon);
  const [x1,y1]=toXY(seg.lat1, seg.lon1);
  const [x2,y2]=toXY(seg.lat2, seg.lon2);
  const A=x-x1,B=y-y1,C=x2-x1,D=y2-y1;
  const dot=A*C+B*D;
  const len_sq=C*C+D*D;
  let param=-1;
  if(len_sq!==0) param=dot/len_sq;
  let xx,yy;
  if(param<0){xx=x1;yy=y1;} else if(param>1){xx=x2;yy=y2;} else {xx=x1+param*C;yy=y1+param*D;}
  const dx=x-xx, dy=y-yy;
  return Math.sqrt(dx*dx+dy*dy);
}
function minDistToRouteMeters(lat, lon, coords){
  if(!coords||coords.length<2) return Infinity;
  let min=Infinity;
  for(let i=1;i<coords.length;i++){
    const seg={lat1:coords[i-1][1],lon1:coords[i-1][0],lat2:coords[i][1],lon2:coords[i][0]};
    const d=distPointSegMeters(lat,lon,seg);
    if(d<min) min=d;
  }
  return min;
}
// -------- Proxy fetch --------
async function fetchViaProxy(url){
  const prox=`/proxy?u=${encodeURIComponent(url)}`;
  const opts={credentials:'omit',cache:'no-store'};
  if(abortCtrl) opts.signal=abortCtrl.signal;
  const r=await fetch(prox,opts);
  if(!r.ok){const txt=await r.text().catch(()=>String(r.status));throw new Error(`Proxy HTTP ${r.status}${txt?": "+txt.slice(0,80):""}`);}
  return r.text();
}

// Proxy-Helfer für JSON-Antworten
async function fetchJsonViaProxy(url){
  const txt = await fetchViaProxy(url);
  try{
    return JSON.parse(txt);
  }catch(err){
    throw new Error("Proxy JSON parse error: "+err.message);
  }
}

// -------- Preisformat --------
function formatPrice(p){
  if(!p) return "VB oder Kostenlos";
  const n = String(p).trim();
  if(n === "") return "VB oder Kostenlos";
  const hasVB = /VB/i.test(n);
  if(hasVB){
    const digits = n.replace(/[^0-9]/g,'');
    if(digits) return new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(Number(digits))+' VB';
    return 'VB';
  }
  if(/[€]/.test(n)) return n;
  const digits=n.replace(/[^0-9]/g,'');
  if(!digits) return "VB oder Kostenlos";
  return new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(Number(digits));
}

// -------- Parsing --------
function cityFromAddr(a){return a?.city||a?.town||a?.village||a?.municipality||a?.county||'';}
function safeParse(json){try{return JSON.parse(json);}catch(_){return null;}}
async function parseListingDetails(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const title=doc.querySelector('meta[property="og:title"]')?.content||doc.title||null;
  let image=doc.querySelector('meta[property="og:image"]')?.content||null;
  let postal=null, cityText=null, lat=null, lon=null;

  // 1) JSON-LD
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
    try{
      const obj=JSON.parse(s.textContent);
      const addr=obj.address||obj.itemOffered?.address||obj.offers?.seller?.address;
      if(addr){
        postal=postal||addr.postalCode||addr.postcode||addr.zip;
        cityText=cityText||addr.addressLocality||addr.city||addr.town;
      }
      if(!image && obj.image){ image=Array.isArray(obj.image)?obj.image[0]:(typeof obj.image==='string'?obj.image:null); }
      const g=obj.geo||obj.location||obj.address?.geo;
      if(g){
        const la=parseFloat(g.latitude||g.lat); const lo=parseFloat(g.longitude||g.lon||g.lng);
        if(!Number.isNaN(la)&&!Number.isNaN(lo)){ lat=lat??la; lon=lon??lo; }
      }
    }catch(_){}
  });

  // 2) __INITIAL_STATE__
  if(!postal||!cityText||lat===null||lon===null){
    doc.querySelectorAll('script').forEach(s=>{
      const t=s.textContent||'';
      if(t.includes('__INITIAL_STATE__')){
        const start=t.indexOf('{'), end=t.lastIndexOf('}');
        if(start>=0&&end>start){
          const st=safeParse(t.slice(start,end+1));
          const a=st?.ad?.adAddress||st?.adInfo?.address||st?.adData?.address||null;
          if(a){
            postal=postal||a.postalCode||a.postcode||a.zipCode;
            cityText=cityText||a.city||a.town||a.addressLocality;
            const g=a.geo||a.coordinates||a.location;
            if(g){
              const la=parseFloat(g.lat||g.latitude); const lo=parseFloat(g.lon||g.lng||g.longitude);
              if(!Number.isNaN(la)&&!Number.isNaN(lo)){ lat=lat??la; lon=lon??lo; }
            }
          }
        }
      }
    });
  }

  // 3) Fallbacks
  if(!postal){
    const m = html.match(/"(?:postalCode|postcode|zip|zipCode|zipcode)"\s*:\s*"?(\d{5})"?/i);
    if(m) postal = m[1];
  }
  if(!postal){
    const ctx=/(\bplz\b|postleitzahl|postal(?:code)?|adresse|address|standort|ort|stadt|gemeinde|wohnort)/i;
    const matches=[...html.matchAll(/\b(\d{5})\b/g)].map(m=>({code:m[1],idx:m.index||0}));
    const filtered=matches.filter(({code,idx})=>{
      const left=Math.max(0,idx-100), right=Math.min(html.length,idx+100);
      const win=html.slice(left,right);
      const prev=html[idx-1]||'', next=html[idx+5]||'';
      const neighborsBad=/[-A-Za-z]/.test(prev)||/[-A-Za-z]/.test(next);
      const looksLikePrice=new RegExp(code+'[\\s\\/,\\.-]*€').test(win);
      const hasContext=ctx.test(win);
      return !neighborsBad && !looksLikePrice && hasContext;
    });
    if(filtered.length) postal=filtered[0].code;
  }
  if(lat===null||lon===null){
    const lm=html.match(/"(?:latitude|lat)"\s*:\s*([0-9.+-]+)/i);
    const lom=html.match(/"(?:longitude|lon|lng)"\s*:\s*([0-9.+-]+)/i);
    if(lm&&lom){ lat=parseFloat(lm[1]); lon=parseFloat(lom[1]); }
  }

  // Preis
  let price=null;
  let vb=html.match(/id=['"]viewad-price['"][^>]*>\s*([^<]*VB[^<]*)</i);
  if(vb){
    price=vb[1].replace(/\s+/g,' ').trim();
  } else {
    let pm= html.match(/"price":"([^"]+)"/i)
          ||html.match(/<meta[^>]+property=['"]product:price:amount['"][^>]*content=['"]([^'"]+)['"]/i)
          ||html.match(/([0-9][0-9\., ]* ?€)/);
    if(pm) price=pm[1].toString().trim();
  }

  return {title,postal,cityText,price:formatPrice(price),image,lat,lon};
}

async function reversePLZ(postal){
  try{
    const url=`/ors/geocode/search/structured?postalcode=${encodeURIComponent(postal)}&country=DE&size=1`;
    const res=await fetch(url,{headers:{"Accept":"application/json"},signal:abortCtrl?.signal});
    if(res.ok){
      const j=await res.json();
      const f=j?.features?.[0];
      if(f){
        const lat=f.geometry.coordinates[1], lon=f.geometry.coordinates[0];
        const props=f.properties||{};
        const city=props.locality||props.region||props.name||"";
        if(city && !/deutschland/i.test(city)){
          return {lat,lon,display:`${postal}${city?` ${city}`:""}`};
        }
      }
    }
  }catch(_){ }

  try{
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=de&postalcode=${encodeURIComponent(postal)}`;
    const j=await fetchJsonViaProxy(url);
    if(j&&j[0]){
      const a=j[0].address||{};
      const city=cityFromAddr(a);
      return {lat:+j[0].lat,lon:+j[0].lon,display:`${postal}${city?` ${city}`:''}`};
    }
  }catch(_){ }

  return {lat:null,lon:null,display:postal};
}

async function geocodeTextOnce(text){
  try{
    const url=`/ors/geocode/search?text=${encodeURIComponent(text)}&boundary.country=DE&size=1`;
    const res=await fetch(url,{headers:{"Accept":"application/json"},signal:abortCtrl?.signal});
    if(!res.ok) throw new Error("ORS geocode failed");
    const j=await res.json();
    const f=j?.features?.[0];
    if(f){
      const lat=f.geometry.coordinates[1], lon=f.geometry.coordinates[0];
      return {lat,lon,label:f.properties.label||text};
    }
    throw new Error("No ORS result");
  }catch(_){
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=de&q=${encodeURIComponent(text)}`;
    const j=await fetchJsonViaProxy(url);
    if(j&&j[0]){const a=j[0].address||{};return {lat:+j[0].lat,lon:+j[0].lon,label:cityFromAddr(a)||text};}
  }
  return {lat:null,lon:null,label:text};
}

async function enrichListing(it,wantDetails=true){
  let lat=null,lon=null,price=formatPrice(it.price||""),postal=null,label=null,image=null,cityText=null;
  if(wantDetails){
    try{
      const html=await fetchViaProxy(it.url);
      const det=await parseListingDetails(html);
      if(det.title) it.title=det.title;
      if(det.price) price=det.price;
      if(det.image) image=det.image;
      postal=det.postal; cityText=det.cityText;
      if(det.lat!=null && det.lon!=null){ lat=det.lat; lon=det.lon; }
    }catch(e){ setStatus("Proxy/Parse-Fehler: "+e.message,true); }
  }
  if(lat===null||lon===null){
    if(postal){
      const g=await reversePLZ(postal);
      lat=g.lat;lon=g.lon;label=g.display;
    } else if(cityText){
      const g=await geocodeTextOnce(cityText+", Deutschland");
      lat=g.lat;lon=g.lon;label=g.label;
    }
  }
  if(!label){
    label = `${postal||""}${cityText?` ${cityText}`:""}`.trim();
  }
  return {lat,lon,label,price,image,postal};
}

// Icons
const greenIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/green-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const blueIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/blue-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const redIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/red-dot.png",iconSize:[32,32],iconAnchor:[16,32]});

// ---------- ROBUSTER MOBILE-FETCH FÜR /api/inserate ----------
async function fetchApiInserate(q, plz, rKm, minPrice, maxPrice) {
  const params=new URLSearchParams({query:q,location:plz,radius:rKm});
  if(minPrice !== null && !Number.isNaN(minPrice)) params.append('min_price', String(minPrice));
  if(maxPrice !== null && !Number.isNaN(maxPrice)) params.append('max_price', String(maxPrice));
  const paramStr=params.toString();
  const tries=[
    `${window.location.origin}/api/inserate?${paramStr}`,
    `/api/inserate?${paramStr}`
  ];

  async function tryOnce(url, useMode) {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 10000);
    let onAbort;
    if(abortCtrl){
      onAbort=()=>ctrl.abort();
      abortCtrl.signal.addEventListener('abort', onAbort);
    }
    try{
      const resp = await fetch(url, {
        method: "GET",
        headers: { "Accept":"application/json" },
        cache: "no-store",
        credentials: "omit",
        ...(useMode ? { mode: "same-origin" } : {}),
        signal: ctrl.signal
      });
      clearTimeout(t);
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    }catch(e){
      clearTimeout(t);
      throw e;
    }finally{
      if(abortCtrl && onAbort) abortCtrl.signal.removeEventListener('abort', onAbort);
    }
  }

  for(const url of tries){
    for(const useMode of [true,false]){
      try{ return await tryOnce(url,useMode); }catch(_){}
    }
  }
  await new Promise(r=>setTimeout(r,300));
  return tryOnce(tries[1], false);
}

// ---------- Start/Stop ----------
let running=false;
let runCounter=0;
let abortCtrl=null;
$("#btnRun").addEventListener("click",()=>{
  if(running){
    running=false;
    runCounter++;
    if(abortCtrl) abortCtrl.abort();
    abortCtrl=null;
    setStatus("Suche abgebrochen.", true);
    setProgressState("aborted", "Abgebrochen");
    $("#btnRun").textContent="Route berechnen & suchen";
    startGroup.classList.remove("hidden");
    zielGroup.classList.remove("hidden");
    queryGroup.classList.remove("hidden");
    priceGroup.classList.remove("hidden");
    settingsGroup.classList.remove("hidden");
    runGroup.classList.add("hidden");
    resetGroup.classList.remove("hidden");
  } else {
    run();
  }
});

async function run(){
  const q=$("#query").value.trim();
  const startText=$("#start").value.trim();
  const zielText=$("#ziel").value.trim();
  const minPriceRaw=priceMinInput.value.trim();
  const maxPriceRaw=priceMaxInput.value.trim();
  const minPrice=minPriceRaw===""?null:Number(minPriceRaw);
  const maxPrice=maxPriceRaw===""?null:Number(maxPriceRaw);
  rKm = radiusOptions[Number(radiusInput.value)] || rKm;
  stepKm = stepOptions[Number(stepInput.value)] || stepKm;
  if(!startText || !zielText){
    setStatus("Bitte Start und Ziel eingeben.", true);
    return;
  }
  const myRun=++runCounter;
  abortCtrl=new AbortController();
  running=true; $("#btnRun").textContent="Abbrechen";
  startGroup.classList.add("hidden");
  zielGroup.classList.add("hidden");
  queryGroup.classList.add("hidden");
  priceGroup.classList.add("hidden");
  settingsGroup.classList.add("hidden");
  mapBox.classList.remove("hidden");
  $("#results").classList.remove("hidden");
  map.invalidateSize();
  clearResults();
  setProgressState("active");
  setProgress(0);

  try{
    const resp=await fetch('/api/route-search',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({start:startText, ziel:zielText, query:q, radius:rKm, step:stepKm, min_price:minPrice, max_price:maxPrice}),
      signal:abortCtrl.signal
    });
    let data=null;
    try{ data=await resp.json(); }catch(_){ }
    if(!resp.ok){
      const detail=data && data.detail ? `: ${data.detail}` : '';
      throw new Error(`HTTP ${resp.status}${detail}`);
    }
    data=data||{};
    const coords=data.route||[];
    if(routeLayer) map.removeLayer(routeLayer);
    if(coords.length){
      routeLayer=L.polyline(coords.map(c=>[c[1],c[0]]),{weight:5,color:'#1e66f5'}).addTo(map);
      map.fitBounds(routeLayer.getBounds());
      const startLatLng=[coords[0][1],coords[0][0]];
      const zielLatLng=[coords[coords.length-1][1],coords[coords.length-1][0]];
      L.marker(startLatLng,{icon:blueIcon}).addTo(resultMarkers).bindPopup("Start");
      L.marker(zielLatLng,{icon:redIcon}).addTo(resultMarkers).bindPopup("Ziel");
    }
    const items=data.listings||[];
    let added=0;
    for(let i=0;i<items.length;i++){
      const it=items[i];
      if(abortCtrl?.signal.aborted) break;
      const info=await enrichListing(it,true);
      if(info.lat!=null && info.lon!=null){
        const dist=minDistToRouteMeters(info.lat,info.lon,coords);
        if(dist/1000<=rKm){
          const imgHtml=info.image?`<img src="${escapeHtml(info.image)}" alt="">`:"";
          const cardHtml=`${imgHtml}<a href="${escapeHtml(it.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(it.title)}</strong></a><div class="muted">${escapeHtml(info.price)}</div>`;
          addResultGalleryGroup(info.label||it.plz||"?", cardHtml);
          addListingToClusters(info.lat,info.lon,cardHtml, info.label||it.plz||"?");
          added++;
        }
      }
      setProgress(Math.min(100, Math.round(((i+1)/items.length)*100)));
    }
    setStatus("Fertig.");
    setProgressState("done", `Fertig – ${added} Inserate`);
    runGroup.classList.add("hidden");
    resetGroup.classList.remove("hidden");
  }catch(e){
    if(myRun===runCounter){
      setStatus(e.message,true);
      setProgressState("aborted","Abgebrochen");
      runGroup.classList.add("hidden");
      resetGroup.classList.remove("hidden");
    }
  }
  running=false; $("#btnRun").textContent="Route berechnen & suchen"; abortCtrl=null;
}


