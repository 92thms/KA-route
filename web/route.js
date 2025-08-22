"use strict";

const CONFIG = window.CONFIG || {};
const ORS_APIKEY = CONFIG.ORS_API_KEY || "";
const rKm = Number(CONFIG.SEARCH_RADIUS_KM) || 10;
const stepKm = Number(CONFIG.STEP_KM) || 50;
const NOMINATIM_HEADERS = { "Accept":"application/json", "Accept-Language":"de" };
const geocodeCache = new Map();

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
const startGroup=$("#grpStart"), zielGroup=$("#grpZiel"), queryGroup=$("#grpQuery"), runGroup=$("#grpRun"), mapBox=$("#map-box");
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

function ensureGroup(loc){
  const key=loc||"Unbekannt";
  if(groups.has(key)) return groups.get(key);
  const wrap=document.createElement('details');
  wrap.className='groupbox'; wrap.open=false;
  wrap.innerHTML=`<summary>${escapeHtml(key)} <span class="badge" data-count="0">0</span></summary><div class="gbody"><div class="gallery"></div></div>`;
  $("#results").appendChild(wrap);
  groups.set(key, wrap);
  return wrap;
}
function clearResults(){
  const r=$("#results");
  r.innerHTML="<strong>Ergebnisliste</strong>";
  r.dataset.cleared="1";
  resultMarkers.clearLayers();markerClusters.length=0;
  groups.clear();
}
function addResultGalleryGroup(loc, cardHtml){
  const results = $("#results");
  if(results.dataset.cleared!="1"){
    results.innerHTML="<strong>Ergebnisliste</strong>";
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

// -------- Debounce & Autocomplete (auf DE beschränkt) --------
function debounce(fn,ms){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms);};}
async function geocodeSuggest(q){
  // Show suggestions as early as possible; we only guard against
  // empty strings. When an ORS API key is available we use the
  // Elasticsearch based geocoder which provides fuzzy matches.
  if(!q||q.length<2) return [];
  if(geocodeCache.has(q)) return geocodeCache.get(q);

  let items;
  if(ORS_APIKEY){
    const url=`https://api.openrouteservice.org/geocode/autocomplete?api_key=${encodeURIComponent(ORS_APIKEY)}&text=${encodeURIComponent(q)}&boundary.country=DE&size=5`;
    const res=await fetch(url,{headers:{"Accept":"application/json"}});
    if(!res.ok) throw new Error("ORS Suggest HTTP "+res.status);
    const data=await res.json();
    items=data.features.map(f=>({
      display_name:f.properties.label,
      lat:f.geometry.coordinates[1],
      lon:f.geometry.coordinates[0]
    }));
  }else{
    const url=`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&countrycodes=de&q=${encodeURIComponent(q)}`;
    const res=await fetch(url,{headers:NOMINATIM_HEADERS});
    if(!res.ok) throw new Error("Nominatim Suggest HTTP "+res.status);
    items=await res.json();
  }
  geocodeCache.set(q, items);
  return items;
}
function bindSuggest(inputSel,listSel){
  const input=$(inputSel), list=$(listSel);
  const render=items=>{
    if(!items.length){list.hidden=true;list.innerHTML="";return;}
    list.innerHTML=items.map(i=>`<li data-lat="${Number(i.lat)}" data-lon="${Number(i.lon)}">${escapeHtml(i.display_name)}</li>`).join("");
    list.hidden=false;
  };
  const onPick=li=>{
    input.value=li.textContent;
    input.dataset.lat=li.getAttribute("data-lat");
    input.dataset.lon=li.getAttribute("data-lon");
    list.hidden=true;
  };
  list.addEventListener("click",e=>{const li=e.target.closest("li");if(li)onPick(li);});
  input.addEventListener("input",debounce(async()=>{
    try{ render(await geocodeSuggest(input.value)); }
    catch(err){ setStatus("Autocomplete-Fehler: "+err.message,true); }
  },250));
  input.addEventListener("blur",()=>setTimeout(()=>list.hidden=true,150));
}
bindSuggest("#start","#start-suggest");
bindSuggest("#ziel","#ziel-suggest");

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
async function buildRouteIndex(coords){
  const RBush=await loadRBush();
  const tree=new RBush();
  const segs=[];
  for(let i=1;i<coords.length;i++){
    const [lon1,lat1]=coords[i-1];
    const [lon2,lat2]=coords[i];
    segs.push({
      minX:Math.min(lon1,lon2),
      minY:Math.min(lat1,lat2),
      maxX:Math.max(lon1,lon2),
      maxY:Math.max(lat1,lat2),
      lon1,lat1,lon2,lat2
    });
  }
  tree.load(segs);
  return {
    distance(lat,lon){
      const ddeg=0.2; // ~20km Suchfenster
      const near=tree.search({minX:lon-ddeg,minY:lat-ddeg,maxX:lon+ddeg,maxY:lat+ddeg});
      let min=Infinity;
      for(const seg of near){
        const d=distPointSegMeters(lat,lon,seg);
        if(d<min) min=d;
      }
      return min;
    }
  };
}

// -------- Proxy fetch --------
async function fetchViaProxy(url){
  const prox=`/proxy?u=${url}`;
  const r=await fetch(prox,{credentials:'omit',cache:'no-store'});
  if(!r.ok){const txt=await r.text().catch(()=>String(r.status));throw new Error(`Proxy HTTP ${r.status}${txt?": "+txt.slice(0,80):""}`);}
  return r.text();
}

// -------- Preisformat --------
function formatPrice(p){
  if(!p)return"VB oder Kostenlos";
  const n=String(p).trim(); if(n==="")return"VB oder Kostenlos";
  if(/[€]/.test(n))return n;
  const digits=n.replace(/[^0-9]/g,''); if(!digits)return"VB oder Kostenlos";
  return new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(Number(digits));
}

// -------- Parsing --------
function cityFromAddr(a){return a?.city||a?.town||a?.village||a?.municipality||a?.county||'';}
function safeParse(json){try{return JSON.parse(json);}catch(_){return null;}}
async function parseListingDetails(html){
  const doc=new DOMParser().parseFromString(html,'text/html');
  const title=doc.querySelector('meta[property="og:title"]')?.content||doc.title||null;
  let image=doc.querySelector('meta[property="og:image"]')?.content||null;
  let postal=null, cityText=null;

  // 1) JSON-LD
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
    try{
      const obj=JSON.parse(s.textContent);
      const addr=obj.address||obj.itemOffered?.address||obj.offers?.seller?.address;
      if(addr){ postal=postal||addr.postalCode||addr.postcode||addr.zip; cityText=cityText||addr.addressLocality||addr.city||addr.town; }
      if(!image && obj.image){ image=Array.isArray(obj.image)?obj.image[0]:(typeof obj.image==='string'?obj.image:null); }
    }catch(_){}
  });

  // 2) __INITIAL_STATE__
  if(!postal||!cityText){
    doc.querySelectorAll('script').forEach(s=>{
      const t=s.textContent||'';
      if(t.includes('__INITIAL_STATE__')){
        const start=t.indexOf('{'), end=t.lastIndexOf('}');
        if(start>=0&&end>start){
          const st=safeParse(t.slice(start,end+1));
          const a=st?.ad?.adAddress||st?.adInfo?.address||st?.adData?.address||null;
          if(a){ postal=postal||a.postalCode||a.postcode||a.zipCode; cityText=cityText||a.city||a.town||a.addressLocality; }
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

  // Preis
  let price=null;
  let pm= html.match(/"price":"([^"]+)"/i)
        ||html.match(/<meta[^>]+property=['"]product:price:amount['"][^>]*content=['"]([^'"]+)['"]/i)
        ||html.match(/([0-9][0-9\., ]* ?€)/);
  if(pm) price=pm[1].toString().trim();

  return {title,postal,cityText,price:formatPrice(price),image};
}

async function reversePLZ(postal){
  try{
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=de&postalcode=${encodeURIComponent(postal)}`;
    const res=await fetch(url,{headers:NOMINATIM_HEADERS});
    const j=await res.json();
    if(j&&j[0]){const a=j[0].address||{};const city=cityFromAddr(a);return {lat:+j[0].lat,lon:+j[0].lon,display:`${postal}${city?` ${city}`:''}`};}
  }catch(_){}
  return {lat:null,lon:null,display:postal};
}
async function geocodeTextOnce(text){
  try{
    const url=`https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=de&q=${encodeURIComponent(text)}`;
    const res=await fetch(url,{headers:NOMINATIM_HEADERS});
    const j=await res.json();
    if(j&&j[0]){const a=j[0].address||{};return {lat:+j[0].lat,lon:+j[0].lon,label:cityFromAddr(a)||text};}
  }catch(_){}
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
    }catch(e){ setStatus("Proxy/Parse-Fehler: "+e.message,true); }
  }
  if(postal){
    const g=await reversePLZ(postal);
    lat=g.lat;lon=g.lon;label=g.display;
  } else if(cityText){
    const g=await geocodeTextOnce(cityText+", Deutschland");
    lat=g.lat;lon=g.lon;label=g.label;
  }
  return {lat,lon,label,price,image,postal};
}

// Icons
const greenIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/green-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const blueIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/blue-dot.png",iconSize:[32,32],iconAnchor:[16,32]});
const redIcon=L.icon({iconUrl:"https://maps.google.com/mapfiles/ms/icons/red-dot.png",iconSize:[32,32],iconAnchor:[16,32]});

// ---------- ROBUSTER MOBILE-FETCH FÜR /api/inserate ----------
async function fetchApiInserate(q, plz, rKm) {
  const params = `query=${encodeURIComponent(q)}&location=${encodeURIComponent(plz)}&radius=${rKm}`;
  const tries = [
    `${window.location.origin}/api/inserate?${params}`,
    `/api/inserate?${params}`
  ];

  async function tryOnce(url, useMode) {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 10000);
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
$("#btnRun").addEventListener("click",()=>{
  if(running){
    running=false;
    setStatus("Suche abgebrochen.", true);
    setProgressState("aborted", "Abgebrochen");
    $("#btnRun").textContent="Route berechnen & suchen";
    startGroup.classList.remove("hidden");
    zielGroup.classList.remove("hidden");
    queryGroup.classList.remove("hidden");
    mapBox.classList.add("hidden");
  } else {
    run();
  }
});

async function run(){
running=true; $("#btnRun").textContent="Abbrechen";
startGroup.classList.add("hidden");
zielGroup.classList.add("hidden");
queryGroup.classList.add("hidden");
mapBox.classList.remove("hidden");
$("#results").classList.remove("hidden");
map.invalidateSize();
clearResults();
setProgressState("active");           // animierte Streifen an
setProgress(0);
let totalFound = 0;                   // Trefferzähler für "Fertig"-Text
const q=$("#query").value.trim();

  // Geocode Inputs
  async function getLonLatFromInput(inp){
    if(inp.dataset.lat&&inp.dataset.lon)return[Number(inp.dataset.lon),Number(inp.dataset.lat)];
    const res=await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(inp.value)}`,{headers:NOMINATIM_HEADERS});
    const j=await res.json(); if(!j.length) throw new Error("Kein Treffer für "+inp.value);
    inp.dataset.lat=j[0].lat;inp.dataset.lon=j[0].lon; return[Number(inp.dataset.lon),Number(inp.dataset.lat)];
  }
  let startLL, zielLL;
  try{startLL=await getLonLatFromInput($("#start"));zielLL=await getLonLatFromInput($("#ziel"));}
catch(e){
  setStatus("Start/Ziel unklar: "+e.message,true);
  running=false;
  setProgressState("aborted","Abgebrochen");
  $("#btnRun").textContent="Route berechnen & suchen";
  startGroup.classList.remove("hidden");
  zielGroup.classList.remove("hidden");
  queryGroup.classList.remove("hidden");
  mapBox.classList.add("hidden");
  return;
}

  // Markers
  const startLatLng=[Number($("#start").dataset.lat), Number($("#start").dataset.lon)];
  const zielLatLng=[Number($("#ziel").dataset.lat), Number($("#ziel").dataset.lon)];
  L.marker(startLatLng,{icon:blueIcon}).addTo(resultMarkers).bindPopup("Start");
  L.marker(zielLatLng,{icon:redIcon}).addTo(resultMarkers).bindPopup("Ziel");

  try{
    const res=await fetch(`https://api.openrouteservice.org/v2/directions/driving-car/geojson`,{
      method:"POST",headers:{"Content-Type":"application/json","Authorization":ORS_APIKEY},
      body:JSON.stringify({coordinates:[startLL,zielLL]})
    });
    const data=await res.json();
    const coords=data.features[0].geometry.coordinates;
    if(routeLayer) map.removeLayer(routeLayer);
    routeLayer=L.polyline(coords.map(c=>[c[1],c[0]]),{weight:5,color:'#1e66f5'}).addTo(map);
    map.fitBounds(routeLayer.getBounds());

    // Route sampling
    function sampleEveryMeters(coords,stepMeters){
      const out=[];let acc=0,prev=coords[0];
      const toMeters=([lon1,lat1],[lon2,lat2])=>{
        const dx=(lon2-lon1)*111320*Math.cos((lat1+lat2)*0.5*Math.PI/180);
        const dy=(lat2-lat1)*110540;return Math.hypot(dx,dy);
      };
      for(let i=1;i<coords.length;i++){
        const d=toMeters(prev,coords[i]);acc+=d;
        if(acc>=stepMeters){acc=0;prev=coords[i];out.push(coords[i]);}
      }
      return out;
    }
    const samples=sampleEveryMeters(coords,stepKm*1000);
    const routeIdx=await buildRouteIndex(coords);
    const plzCache=new Map();
    const inserateCache=new Map();
    let done=0; const seen=new Set();
    const DETAIL_LIMIT=10, DETAIL_PAR=4, WORKERS=4;
    let nextIndex=0;

    function progressIncrement(){
      done++; setProgress(Math.round(done/samples.length*100));
    }

    async function processSample(idx){
      const [lonS,latS]=samples[idx];
      const key=latS.toFixed(3)+"|"+lonS.toFixed(3);
      let plz=plzCache.get(key);
      if(!plz){
        try{
          const r=await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latS}&lon=${lonS}&format=jsonv2&zoom=10&addressdetails=1`,{headers:NOMINATIM_HEADERS});
          const j=await r.json(); plz=j?.address?.postcode||null;
        }catch(_){}
        plzCache.set(key,plz);
      }
      if(!plz){ progressIncrement(); return; }

      let items=inserateCache.get(plz);
      if(!items){
        try{
          const j=await fetchApiInserate(q,plz,rKm);
          items=j?.data||[];
          inserateCache.set(plz,items);
        }catch(e){
          setStatus(`API-Netzwerkfehler für PLZ ${plz}: ${e.message}`,true);
          items=[];
        }
      }
      setStatus(`PLZ ${plz}: ${items.length} Treffer`);

      const fresh=[];
      for(const it of items){
        if(seen.has(it.url)) continue; seen.add(it.url);
        fresh.push(it);
        if(fresh.length>=DETAIL_LIMIT) break;
      }

      for(let i=0;i<fresh.length;i+=DETAIL_PAR){
        const chunk=fresh.slice(i,i+DETAIL_PAR);
        const results=await Promise.allSettled(chunk.map(it=>enrichListing(it,true)));
        results.forEach((res,idx)=>{
          if(res.status!=="fulfilled") return;
          const enrich=res.value;
          if(!enrich.lat||!enrich.lon) return;
          const minDist=routeIdx.distance(enrich.lat,enrich.lon);
          if(minDist>10000) return;
          totalFound++;
          const it=chunk[idx];
          const loc=enrich.label||plz||"?";
          const price=enrich.price;
          const cardHtml=`
          <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">
            ${enrich.image?`<img src="${escapeHtml(enrich.image)}" alt="">`:''}
            <strong>${escapeHtml(it.title)}</strong>
          </a>
          <div class="muted">${escapeHtml(price)}</div>
        `;
          addResultGalleryGroup(loc, cardHtml);
          const popupHtml=`<a href="${escapeHtml(it.url)}" target="_blank"><strong>${escapeHtml(it.title)}</strong></a><br>${escapeHtml(price)}<br>${escapeHtml(loc)}${enrich.image?`<br><img src="${escapeHtml(enrich.image)}" style="max-width:180px;border-radius:8px">`:''}`;
          addListingToClusters(enrich.lat,enrich.lon,popupHtml,"Anzeigen in der Nähe");
        });
      }

      progressIncrement();
    }

    async function worker(){
      while(running){
        const idx=nextIndex++;
        if(idx>=samples.length) break;
        await processSample(idx);
      }
    }

      await Promise.all(Array.from({length:WORKERS},()=>worker()));
  setStatus("Fertig.");
  setProgress(100);
  setProgressState("done", `Fertig – ${totalFound} Inserate`);
  runGroup.classList.add("hidden");
}catch(e){
  setStatus(e.message,true);
  setProgressState("aborted","Abgebrochen");
  startGroup.classList.remove("hidden");
  zielGroup.classList.remove("hidden");
  queryGroup.classList.remove("hidden");
  mapBox.classList.add("hidden");
}
running=false; $("#btnRun").textContent="Route berechnen & suchen";
}
