// script.js
// Leaflet-based vehicle simulator

//  Utilities
function haversineDistance(a, b) {
  // returns dis in mtrs between a:{lat,lng} and b:{lat,lng}
  const R = 6371000; // meters
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const aa = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}
function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  const h = String(Math.floor(sec / 3600)).padStart(2,'0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2,'0');
  const s = String(sec % 60).padStart(2,'0');
  return `${h}:${m}:${s}`;
}

// === DOM ===
const playPauseBtn = document.getElementById('playPauseBtn');
const speedSelect = document.getElementById('speedSelect');
const restartBtn = document.getElementById('restartBtn');
const currentCoordEl = document.getElementById('currentCoord');
const elapsedEl = document.getElementById('elapsed');
const speedEl = document.getElementById('speed');
const distanceEl = document.getElementById('distance');

// === Map setup ===
const map = L.map('map', {zoomControl:true});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Predefine variables
let rawRoute = []; // original points as {lat,lng,timeMs}
let fullPolyline, livePolyline, marker;
let totalDistance = 0;
let totalDuration = 0;
let isPlaying = false;
let simTime = 0; // ms
let animationFrameId = null;
let lastFrameTs = null;
let speedMultiplier = 1;

// Load dummy-route.json
async function loadRoute() {
  const resp = await fetch('dummy-route.json');
  if (!resp.ok) throw new Error('Failed to load dummy-route.json (serve via HTTP).');
  const arr = await resp.json();
  rawRoute = arr.map(p => ({
    lat: p.latitude,
    lng: p.longitude,
    time: p.timestamp ? (new Date(p.timestamp)).getTime() : null
  }));

  // If timestamps are missing, create synthetic timeline: 5s per segment
  if (!rawRoute.every(p => p.time !== null)) {
    console.warn('Timestamps not found for all points — using fixed 5s intervals.');
    let t0 = Date.now();
    rawRoute.forEach((p, idx) => p.time = t0 + idx * 5000);
  }

  // Precompute distances & durations
  totalDistance = 0;
  for (let i = 0; i < rawRoute.length - 1; i++) {
    const a = {lat: rawRoute[i].lat, lng: rawRoute[i].lng};
    const b = {lat: rawRoute[i+1].lat, lng: rawRoute[i+1].lng};
    const d = haversineDistance(a, b);
    rawRoute[i].distToNext = d;
    rawRoute[i].durToNext = rawRoute[i+1].time - rawRoute[i].time; // ms
    totalDistance += d;
  }
  totalDuration = rawRoute[rawRoute.length - 1].time - rawRoute[0].time;
  initMap();
}

function initMap() {
  // Fit map to route
  const latlngs = rawRoute.map(p => [p.lat, p.lng]);
  fullPolyline = L.polyline(latlngs, {color: '#9CA3AF', weight: 4, opacity:0.6}).addTo(map);
  livePolyline = L.polyline([], {color: '#2563eb', weight:4}).addTo(map);

  // center & zoom
  map.fitBounds(fullPolyline.getBounds(), {padding: [40,40]});

  // create a small car SVG icon
  const carSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24">
      <path fill="#2563eb" d="M3 11.5C3 9.57 4.57 8 6.5 8h11c1.93 0 3.5 1.57 3.5 3.5V18h-1.5v2h-1v-2H5v2H4v-2H2.5v-6.5zM6.5 10C5.67 10 5 10.67 5 11.5S5.67 13 6.5 13 8 12.33 8 11.5 7.33 10 6.5 10zM17.5 10c-.83 0-1.5.67-1.5 1.5S16.67 13 17.5 13 19 12.33 19 11.5 18.33 10 17.5 10z"/>
    </svg>`);

  const carIcon = L.icon({
    iconUrl: `data:image/svg+xml;utf8,${carSvg}`,
    iconSize: [36,36],
    iconAnchor: [18,18]
  });

  // place marker at start
  marker = L.marker([rawRoute[0].lat, rawRoute[0].lng], {icon:carIcon}).addTo(map);
  livePolyline.addLatLng([rawRoute[0].lat, rawRoute[0].lng]);

  // initialize simTime to start
  simTime = rawRoute[0].time;
  updateUIForTime(simTime);
}

// Animation loop
function animate(ts) {
  if (!lastFrameTs) lastFrameTs = ts;
  const dt = ts - lastFrameTs; // ms
  lastFrameTs = ts;

  if (isPlaying) {
    simTime += dt * speedMultiplier;
    if (simTime >= rawRoute[rawRoute.length - 1].time) {
      // stop at end
      simTime = rawRoute[rawRoute.length - 1].time;
      isPlaying = false;
      playPauseBtn.textContent = 'Play';
    }
    updateMarkerForSimTime(simTime);
  }

  animationFrameId = requestAnimationFrame(animate);
}

function updateMarkerForSimTime(tms) {
  // find segment s where t in [t_s, t_{s+1}]
  let i = rawRoute.findIndex((p, idx) => {
    if (idx === rawRoute.length - 1) return false;
    return tms >= p.time && tms <= rawRoute[idx+1].time;
  });

  if (i === -1) {
    // if beyond end, set to last point
    const last = rawRoute[rawRoute.length - 1];
    marker.setLatLng([last.lat, last.lng]);
    livePolyline.addLatLng([last.lat, last.lng]);
    updateUIForTime(tms);
    return;
  }

  const p0 = rawRoute[i];
  const p1 = rawRoute[i+1];
  const segDur = p1.time - p0.time; // ms
  const frac = segDur === 0 ? 1 : (tms - p0.time) / segDur;
  const lat = p0.lat + (p1.lat - p0.lat) * frac;
  const lng = p0.lng + (p1.lng - p0.lng) * frac;

  // move marker
  marker.setLatLng([lat, lng]);

  // append current pos to live polyline (but avoid huge number of vertices)
  const lastLatLngs = livePolyline.getLatLngs();
  const last = lastLatLngs.length ? lastLatLngs[lastLatLngs.length - 1] : null;
  if (!last || last.lat !== lat || last.lng !== lng) {
    livePolyline.addLatLng([lat, lng]);
  }

  updateUIForTime(tms, i, frac);
}

function updateUIForTime(tms, segIndex = null, frac = null) {
  const start = rawRoute[0].time;
  const elapsedMs = tms - start;
  elapsedEl.textContent = formatTime(elapsedMs);

  // find nearest previous route point index
  let idx = rawRoute.findIndex((p, i) => i < rawRoute.length - 1 && tms >= p.time && tms <= rawRoute[i+1].time);
  if (idx === -1) idx = rawRoute.length - 1;
  let currentLat, currentLng;
  if (idx < rawRoute.length - 1) {
    const p0 = rawRoute[idx];
    const p1 = rawRoute[idx+1];
    const fraction = (tms - p0.time) / (p1.time - p0.time);
    currentLat = p0.lat + (p1.lat - p0.lat) * fraction;
    currentLng = p0.lng + (p1.lng - p0.lng) * fraction;
  } else {
    currentLat = rawRoute[rawRoute.length - 1].lat;
    currentLng = rawRoute[rawRoute.length - 1].lng;
  }
  currentCoordEl.textContent = `${currentLat.toFixed(6)}, ${currentLng.toFixed(6)}`;

  // compute instantaneous speed based on nearest segment (m/s -> km/h)
  let instSpeedKmh = 0;
  if (idx < rawRoute.length - 1) {
    const d = rawRoute[idx].distToNext; // meters
    const durSec = Math.max(1, rawRoute[idx].durToNext / 1000); // seconds
    const mps = d / durSec;
    instSpeedKmh = mps * 3.6;
    speedEl.textContent = `${instSpeedKmh.toFixed(2)} km/h`;
  } else {
    speedEl.textContent = `0.00 km/h`;
  }

  // distance traveled so far (approx): sum of previous segments + fraction of current
  let dist = 0;
  for (let j = 0; j < rawRoute.length - 1; j++) {
    if (rawRoute[j].time + rawRoute[j].durToNext <= tms) {
      dist += rawRoute[j].distToNext;
    } else if (rawRoute[j].time <= tms) {
      const part = Math.max(0, (tms - rawRoute[j].time) / rawRoute[j].durToNext);
      dist += rawRoute[j].distToNext * part;
      break;
    } else break;
  }
  distanceEl.textContent = `${dist.toFixed(1)} m`;
}

// Controls
playPauseBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  playPauseBtn.textContent = isPlaying ? 'Pause' : 'Play';
  if (isPlaying) {
    lastFrameTs = null; // re-sync
  }
});
speedSelect.addEventListener('change', () => {
  speedMultiplier = Number(speedSelect.value);
});
restartBtn.addEventListener('click', () => {
  simTime = rawRoute[0].time;
  livePolyline.setLatLngs([[rawRoute[0].lat, rawRoute[0].lng]]);
  marker.setLatLng([rawRoute[0].lat, rawRoute[0].lng]);
  if (!isPlaying) {
    updateUIForTime(simTime);
  }
});

// start
loadRoute().then(() => {
  animationFrameId = requestAnimationFrame(animate);
}).catch(err => {
  alert('Error loading route: ' + err.message + '\nServe the project via a local HTTP server (see README).');
});
