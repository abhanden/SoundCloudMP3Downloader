"use strict";

// ---------- Config (only place to change the repo) ----------
const REPO = "abhanden/SoundCloudMP3Downloader";
const BRANCH = "main";
const FOLDER = REPO.split("/")[1];
const OEMBED = "https://soundcloud.com/oembed";
// Same rule as app.py: force the t500x500.jpg artwork
const SIZE_RE = /-(?:large|original|crop|badge|small|tiny|mini|t\d+x\d+)\.(?:jpe?g|png|webp)(?=$|\?)/i;
const NS = "http://www.w3.org/2000/svg";
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- Links ----------
const LINKS = {
  repo: `https://github.com/${REPO}`,
  zip: `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`,
  raw: `https://raw.githubusercontent.com/${REPO}/${BRANCH}/app.py`,
  releases: `https://github.com/${REPO}/releases/latest`,
};
document.querySelectorAll("[data-link]").forEach((a) => {
  a.href = LINKS[a.dataset.link];
});

// ---------- Waveform ----------
const wave = (() => {
  const svg = $("#wave");
  const N = 150, H = 96, BW = 5, GAP = 3;
  const bars = [];
  let timer = null;
  let pos = 0;

  // Seeded random: same wave on every load
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  svg.setAttribute("viewBox", `0 0 ${N * (BW + GAP) - GAP} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  for (let i = 0; i < N; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin((i / N) * Math.PI * 3.2 + 0.6));
    const h = Math.max(6, H * env * (0.35 + 0.65 * rnd()));
    const r = document.createElementNS(NS, "rect");
    r.setAttribute("x", i * (BW + GAP));
    r.setAttribute("y", (H - h) / 2);
    r.setAttribute("width", BW);
    r.setAttribute("height", h);
    r.setAttribute("rx", 1);
    r.setAttribute("class", "bar");
    r.style.setProperty("--d", `${i * 5}ms`);
    svg.append(r);
    bars.push(r);
  }

  return {
    reset() {
      clearInterval(timer);
      pos = 0;
      bars.forEach((b) => b.classList.remove("on"));
    },
    // Sweep to ~90% while loading
    run() {
      this.reset();
      const limit = Math.floor(N * 0.9);
      if (reduceMotion) {
        bars.slice(0, limit).forEach((b) => b.classList.add("on"));
        return;
      }
      timer = setInterval(() => {
        if (pos < limit) bars[pos++].classList.add("on");
      }, 8);
    },
    finish() {
      clearInterval(timer);
      bars.forEach((b) => b.classList.add("on"));
    },
  };
})();

// ---------- oEmbed preview ----------
const form = $("#preview-form");
const input = $("#url");
const goBtn = $("#go");
const statusEl = $("#status");
const result = $("#result");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function parseScUrl(raw) {
  try {
    const u = new URL(raw.trim());
    const okHost = /^(www\.|m\.|on\.)?soundcloud\.com$/i.test(u.hostname);
    return okHost && u.protocol.startsWith("http") ? u.href : null;
  } catch {
    return null;
  }
}

// JSON first (CORS), JSONP as fallback
async function oembedFetch(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${OEMBED}?format=json&url=${encodeURIComponent(url)}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`oEmbed ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function oembedJsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = `__scoembed_${Date.now()}`;
    const s = document.createElement("script");
    const cleanup = () => {
      delete window[cb];
      s.remove();
      clearTimeout(t);
    };
    const t = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
    window[cb] = (data) => { cleanup(); resolve(data); };
    s.onerror = () => { cleanup(); reject(new Error("blocked")); };
    s.src = `${OEMBED}?format=js&url=${encodeURIComponent(url)}&callback=${cb}`;
    document.head.append(s);
  });
}

async function getOembed(url) {
  try {
    return await oembedFetch(url);
  } catch {
    return oembedJsonp(url);
  }
}

// "Track by Artist" -> "Track"
function splitTitle(title, author) {
  const suffix = ` by ${author}`;
  return author && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
}

// Only accept SoundCloud's own player URL from the oEmbed html
function playerSrc(html) {
  const m = /src="([^"]+)"/.exec(html || "");
  const src = m && m[1].replace(/&amp;/g, "&");
  return src && src.startsWith("https://w.soundcloud.com/player/") ? src : null;
}

function loadCover(thumb) {
  const img = $("#cover");
  const cap = $("#cover-info");
  const link = $("#cover-link");
  const tag = $("#tag-cover");
  const hires = thumb ? thumb.replace(SIZE_RE, "-t500x500.jpg") : "";
  let triedFallback = false;

  cap.textContent = "";
  link.hidden = true;
  img.hidden = false;

  img.onload = () => {
    const size = `${img.naturalWidth} × ${img.naturalHeight} px`;
    cap.textContent = `${size}, saved as JPEG`;
    tag.textContent = `front cover, JPEG, ${size}`;
    link.href = img.src;
    link.hidden = false;
  };
  img.onerror = () => {
    if (!triedFallback && thumb && img.src !== thumb) {
      triedFallback = true;
      img.src = thumb; // original SoundCloud thumbnail
      return;
    }
    img.hidden = true;
    cap.textContent = "No cover found for this link.";
    tag.textContent = "none";
  };

  if (hires) img.src = hires;
  else img.onerror();
}

function showResult(data) {
  const artist = data.author_name || "";
  const title = splitTitle(data.title || "Untitled", artist);

  $("#res-title").textContent = title;
  $("#res-artist").textContent = artist;
  $("#tag-title").textContent = title;
  $("#tag-artist").textContent = artist || "Unknown";

  const box = $("#player");
  box.replaceChildren();
  const src = playerSrc(data.html);
  if (src) {
    const f = document.createElement("iframe");
    f.src = src;
    f.title = `SoundCloud player: ${title}`;
    f.loading = "lazy";
    f.allow = "autoplay";
    f.style.height = `${Math.min(Number(data.height) || 166, 450)}px`;
    box.append(f);
  }

  loadCover(data.thumbnail_url);
  result.hidden = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = parseScUrl(input.value);
  if (!url) {
    setStatus("That is not a SoundCloud link. Use a URL like https://soundcloud.com/artist/track.", true);
    input.focus();
    return;
  }

  goBtn.disabled = true;
  goBtn.textContent = "Loading...";
  result.hidden = true;
  wave.run();
  setStatus("Loading preview...");

  try {
    const data = await getOembed(url);
    showResult(data);
    wave.finish();
    setStatus("");
  } catch {
    wave.reset();
    setStatus("No preview found. The link must point to a public track, playlist or profile.", true);
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = "Show preview";
  }
});

// ---------- Install guide ----------
const GUIDE = {
  windows: {
    label: "Windows",
    steps: [
      { t: "Install Python 3.9 or newer", p: "Download it from python.org. Tick \"Add python.exe to PATH\" in the installer.",
        blocks: [{ code: "python --version" }] },
      { t: "Install FFmpeg", p: "Open a new terminal afterwards so PATH is refreshed. Prefer a manual unzip? Skip this and use --ffmpeg-location in the last step.",
        blocks: [{ code: "winget install Gyan.FFmpeg" }] },
      { t: "Get the code",
        blocks: [{ code: `git clone ${LINKS.repo}.git\ncd ${FOLDER}` }] },
      { t: "Install the packages",
        blocks: [{ code: "python -m venv venv\nvenv\\Scripts\\activate\npip install -r requirements.txt" }] },
      { t: "Start the app", p: "FFmpeg is in your PATH:",
        blocks: [
          { code: "python app.py" },
          { note: "FFmpeg is not in your PATH. Point the app to the folder with ffmpeg and ffprobe:", code: 'python app.py --ffmpeg-location "C:\\ffmpeg\\bin"' },
        ] },
    ],
  },
  mac: {
    label: "macOS",
    steps: [
      { t: "Install Python and FFmpeg", p: "With Homebrew (brew.sh):",
        blocks: [{ code: "brew install python ffmpeg python-tk" }] },
      { t: "Get the code",
        blocks: [{ code: `git clone ${LINKS.repo}.git\ncd ${FOLDER}` }] },
      { t: "Install the packages",
        blocks: [{ code: "python3 -m venv venv\nsource venv/bin/activate\npip install -r requirements.txt" }] },
      { t: "Start the app", p: "FFmpeg is in your PATH:",
        blocks: [
          { code: "python3 app.py" },
          { note: "FFmpeg is somewhere else:", code: "python3 app.py --ffmpeg-location /opt/ffmpeg/bin" },
        ] },
    ],
  },
  linux: {
    label: "Linux",
    steps: [
      { t: "Install Python, Tk and FFmpeg", p: "Debian and Ubuntu. Tk is needed for the GUI:",
        blocks: [{ code: "sudo apt install python3 python3-venv python3-tk ffmpeg git" }] },
      { t: "Get the code",
        blocks: [{ code: `git clone ${LINKS.repo}.git\ncd ${FOLDER}` }] },
      { t: "Install the packages",
        blocks: [{ code: "python3 -m venv venv\nsource venv/bin/activate\npip install -r requirements.txt" }] },
      { t: "Start the app", p: "FFmpeg is in your PATH:",
        blocks: [
          { code: "python3 app.py" },
          { note: "FFmpeg is somewhere else:", code: "python3 app.py --ffmpeg-location /opt/ffmpeg/bin" },
        ] },
    ],
  },
};

const USAGE = [
  "Paste one or more SoundCloud links: a track, playlist, album or Go+ link. Separate several links with a space.",
  "Choose the target folder. The default is Music/SoundCloud in your home folder.",
  "Click Download. The log prints one line per track, for example: OK: Artist - Title.mp3 | 320 kbps | cover: yes",
  "cover: NO means no thumbnail could be loaded for that track.",
  "Go+ tracks without a login only provide the 30 second preview.",
  "Download stops working after a SoundCloud change? Update yt-dlp: pip install -U yt-dlp",
];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function codeBlock(b) {
  return `${b.note ? `<p>${esc(b.note)}</p>` : ""}
    <pre class="cmd"><code>${esc(b.code)}</code><button class="copy" type="button" aria-label="Copy command">Copy</button></pre>`;
}

function renderGuide(os) {
  const g = GUIDE[os];
  const steps = g.steps.map((s) => `
    <li class="step"><div class="step-body">
      <h3>${esc(s.t)}</h3>
      ${s.p ? `<p>${esc(s.p)}</p>` : ""}
      ${s.blocks.map(codeBlock).join("")}
    </div></li>`).join("");

  $("#guide").innerHTML = `
    <ol class="steps" id="panel-${os}" role="tabpanel" aria-label="${g.label} install steps">${steps}</ol>
    <div class="usage">
      <h3>Using the app</h3>
      <ul>${USAGE.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
    </div>`;

  document.querySelectorAll(".tab").forEach((t) => {
    t.setAttribute("aria-selected", String(t.dataset.os === os));
    t.tabIndex = t.dataset.os === os ? 0 : -1;
  });
}

function detectOs() {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return "linux";
  return "windows";
}

(function initGuide() {
  const tabs = $("#tabs");
  tabs.innerHTML = Object.entries(GUIDE)
    .map(([k, g]) => `<button class="tab" type="button" role="tab" data-os="${k}" aria-controls="panel-${k}">${g.label}</button>`)
    .join("");

  tabs.addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) renderGuide(t.dataset.os);
  });

  // Arrow keys move between tabs
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const list = [...tabs.querySelectorAll(".tab")];
    const i = list.findIndex((t) => t === document.activeElement);
    const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
    next.focus();
    renderGuide(next.dataset.os);
  });

  renderGuide(detectOs());
})();

// ---------- Copy buttons ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for http / old browsers
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const ok = await copyText(btn.parentElement.querySelector("code").textContent);
  btn.textContent = ok ? "Copied" : "Failed";
  setTimeout(() => (btn.textContent = "Copy"), 1500);
});
