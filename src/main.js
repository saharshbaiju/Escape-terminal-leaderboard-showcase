// Realtime leaderboard showcase. New runs arrive via Supabase realtime (with a
// polling fallback), pop up as a hero card, then either take a podium seat (top
// 3) or hop down the ranked list into place. Top 3 stay pinned as cards.
import "./style.css";
import {
  enabled,
  fetchTop,
  fetchRecent,
  fetchCount,
  subscribe,
} from "./supabase.js";
import QRCode from "qrcode";

const RAW_N = import.meta.env.VITE_TOP_N;
const N = RAW_N && parseInt(RAW_N, 10) > 0 ? parseInt(RAW_N, 10) : Infinity;
const MAX = 500;
const PLAY_URL = import.meta.env.VITE_PLAY_URL || "https://escapeterminal.vercel.app/";

const podiumEl = document.getElementById("podium");
const board = document.getElementById("board");
const heroLayer = document.getElementById("hero-layer");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const clockEl = document.getElementById("clock");
const tickerEl = document.getElementById("ticker");

let all = [];
let countExact = 0;
const seen = new Set();
const queue = [];
let busy = false;
let autoScrollTimer = null;

const MEDALS = ["🥇", "🥈", "🥉"];

// --- helpers ---------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function fmtTime(s) {
  s = Math.trunc(s || 0);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const BADGE = {
  "CLEAN ESCAPE": "b-clean",
  ESCAPED: "b-escaped",
  "PARTIAL ESCAPE": "b-partial",
  "SYSTEM LOCKDOWN": "b-lockdown",
  "STILL TRAPPED": "b-trapped",
};
const badgeClass = (o) => BADGE[o] || "b-escaped";
function sortAll() {
  all.sort((a, b) => b.score - a.score || a.total_seconds - b.total_seconds);
}
function scoreBar(score) {
  const f = Math.round((Math.min(100, Math.max(0, score)) / 100) * 10);
  return "▰".repeat(f) + "▱".repeat(10 - f);
}
function updateCount() {
  countEl.textContent = `${countExact} RUN${countExact === 1 ? "" : "S"}`;
}
function updateEmpty() {
  emptyEl.classList.toggle("hide", all.length > 0 || !enabled);
}
function setTicker(t) {
  tickerEl.textContent = t;
}

// --- podium (top 3, pinned) ------------------------------------------------
function makePodiumCard(r, rankIdx) {
  const card = el("div", "pcard p" + (rankIdx + 1));
  card.dataset.id = r.id;
  card.append(el("div", "medal", MEDALS[rankIdx] || ""));
  card.append(el("div", "p-rank", `RANK #${rankIdx + 1}`));
  card.append(el("div", "p-name", r.name));
  const score = el("div", "p-score");
  score.innerHTML = `${r.score}<small>/100</small>`;
  card.append(score);
  card.append(el("div", "p-bar", scoreBar(r.score)));
  const badge = el("div", "p-badge " + badgeClass(r.outcome));
  badge.textContent = r.outcome;
  card.append(badge);
  card.append(el("div", "p-time", "⏱ " + fmtTime(r.total_seconds)));
  return card;
}
function renderPodium(newId) {
  const top3 = all.slice(0, 3);
  podiumEl.innerHTML = "";
  // arrange as #2 · #1 · #3 so the champion sits centre
  const order = top3.length === 3 ? [1, 0, 2] : top3.map((_, i) => i);
  for (const idx of order) {
    const r = top3[idx];
    if (!r) continue;
    const card = makePodiumCard(r, idx);
    podiumEl.append(card);
    if (r.id === newId) {
      card.classList.add("pcard-flash");
      card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: "ease-out" });
      setTimeout(() => card.classList.remove("pcard-flash"), 4200);
    }
  }
}

// --- ranked list (rank 4+) -------------------------------------------------
function makeRow(r, globalRank) {
  const row = el("div", "row");
  row.dataset.id = r.id;
  row.append(el("div", "rank", String(globalRank)));
  row.append(el("div", "handle", r.name));
  const badge = el("div", "badge " + badgeClass(r.outcome));
  badge.textContent = r.outcome;
  row.append(badge);
  row.append(el("div", "score", String(r.score)));
  row.append(el("div", "time", fmtTime(r.total_seconds)));
  return row;
}
function listSlice() {
  return all.slice(3, N);
}
function renderListPlain() {
  const list = listSlice();
  board.innerHTML = "";
  list.forEach((r, i) => board.append(makeRow(r, i + 4)));
  updateEmpty();
}
function renderListWithAnimation(newId) {
  const oldTops = new Map();
  [...board.children].forEach((ch) => {
    if (ch.dataset.id) oldTops.set(ch.dataset.id, ch.offsetTop);
  });
  const list = listSlice();
  board.innerHTML = "";
  const rowEls = list.map((r, i) => makeRow(r, i + 4));
  rowEls.forEach((e) => board.append(e));
  updateEmpty();
  const rowStep =
    rowEls.length > 1
      ? rowEls[1].offsetTop - rowEls[0].offsetTop
      : rowEls[0]
        ? rowEls[0].offsetHeight
        : 0;
  const newRowEl = newId ? rowEls.find((e) => e.dataset.id === newId) : null;
  if (newRowEl) newRowEl.scrollIntoView({ block: "center" });
  const targetIndex = newId ? list.findIndex((r) => r.id === newId) : -1;

  rowEls.forEach((e) => {
    const id = e.dataset.id;
    if (id === newId) {
      descendAnimate(e, targetIndex, rowStep);
      e.classList.add("row-new");
      setTimeout(() => e.classList.remove("row-new"), 7200);
    } else if (oldTops.has(id)) {
      const dy = oldTops.get(id) - e.offsetTop;
      if (dy) {
        e.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
          duration: 650,
          easing: "cubic-bezier(.2,.85,.25,1)",
        });
      }
    } else {
      e.animate(
        [
          { opacity: 0, transform: `translateY(${rowStep}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 500, easing: "ease-out" },
      );
    }
  });
}

function descendAnimate(rowEl, targetIndex, rowStep) {
  if (targetIndex <= 0 || rowStep <= 0) {
    rowEl.animate([{ transform: "scale(1.2)" }, { transform: "scale(1)" }], {
      duration: 600,
      easing: "cubic-bezier(.34,1.56,.64,1)",
    });
    return;
  }
  rowEl.classList.add("row-descending");
  const steps = Math.min(targetIndex, 8);
  const frames = [];
  for (let k = 0; k <= steps; k++) {
    const y = -(steps - k) * rowStep;
    frames.push({ transform: `translateY(${y}px) scale(1.1)`, offset: k / steps });
    if (k < steps) {
      const y0 = -(steps - k) * rowStep;
      const y1 = -(steps - (k + 1)) * rowStep;
      const yMid = (y0 + y1) / 2 - rowStep * 0.55;
      frames.push({ transform: `translateY(${yMid}px) scale(1.0)`, offset: (k + 0.5) / steps });
    }
  }
  const dur = Math.min(2200, Math.max(750, steps * 240));
  const anim = rowEl.animate(frames, { duration: dur, easing: "linear" });
  anim.onfinish = () => rowEl.classList.remove("row-descending");
}

function renderAll() {
  sortAll();
  renderPodium(null);
  renderListPlain();
}

function staggerEntrance() {
  [...podiumEl.children].forEach((e, i) =>
    e.animate(
      [{ opacity: 0, transform: "translateY(22px)" }, { opacity: 1, transform: "none" }],
      { duration: 520, delay: i * 130, easing: "ease-out", fill: "backwards" },
    ),
  );
  [...board.children].forEach((e, i) =>
    e.animate(
      [{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }],
      { duration: 420, delay: Math.min(i * 60, 1200), easing: "ease-out", fill: "backwards" },
    ),
  );
}

// --- hero card -------------------------------------------------------------
function countUp(node, to, dur) {
  const start = performance.now();
  function step(t) {
    const p = Math.min(1, (t - start) / dur);
    node.textContent = Math.round(to * (0.5 - Math.cos(p * Math.PI) / 2));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function hero(row, globalRank) {
  return new Promise((resolve) => {
    const card = el("div", "hero-card");
    card.innerHTML =
      `<div class="hero-tag">NEW ESCAPE</div>` +
      `<div class="hero-name"></div>` +
      `<div class="hero-badge ${badgeClass(row.outcome)}"></div>` +
      `<div class="hero-stats">` +
      `<div class="hero-stat"><div class="v" id="hv-score">0</div><div class="l">SCORE</div></div>` +
      `<div class="hero-stat"><div class="v">${fmtTime(row.total_seconds)}</div><div class="l">TIME</div></div>` +
      `<div class="hero-stat hero-rank"><div class="v">#${globalRank + 1}</div><div class="l">RANK</div></div>` +
      `</div>`;
    card.querySelector(".hero-name").textContent = row.name;
    card.querySelector(".hero-badge").textContent = row.outcome;
    heroLayer.append(card);
    card.animate(
      [
        { opacity: 0, transform: "scale(.6)" },
        { opacity: 1, transform: "scale(1.06)", offset: 0.7 },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 600, easing: "cubic-bezier(.34,1.56,.64,1)", fill: "forwards" },
    );
    countUp(card.querySelector("#hv-score"), row.score, 900);
    setTimeout(() => {
      const out = card.animate(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(.4) translateY(-12vh)" },
        ],
        { duration: 650, easing: "ease-in", fill: "forwards" },
      );
      out.onfinish = () => {
        card.remove();
        resolve();
      };
    }, 2200);
  });
}

// --- queue (one animation at a time) ---------------------------------------
function enqueue(row) {
  if (!row || seen.has(row.id)) return;
  seen.add(row.id);
  queue.push(row);
  pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await animateNew(queue.shift());
  busy = false;
}
async function animateNew(row) {
  all.push(row);
  sortAll();
  countExact += 1;
  updateCount();
  const globalRank = all.findIndex((r) => r.id === row.id);
  setTicker(`▸ ${row.name} just escaped — ${row.outcome} · ${row.score} pts · rank #${globalRank + 1}`);
  await hero(row, globalRank);
  if (globalRank < 3) {
    renderPodium(row.id);
    renderListWithAnimation(null); // an old top-3 row may drop into the list
  } else {
    renderPodium(null);
    renderListWithAnimation(row.id);
  }
}

function handleDelete(old) {
  if (!old) return;
  const i = all.findIndex((r) => r.id === old.id);
  if (i >= 0) all.splice(i, 1);
  seen.delete(old.id);
  countExact = Math.max(0, countExact - 1);
  renderAll();
  updateCount();
}

// --- auto-scroll (hands-off TV) --------------------------------------------
function startAutoScroll() {
  if (autoScrollTimer) return;
  autoScrollTimer = setInterval(() => {
    if (busy) return;
    if (board.scrollHeight - board.clientHeight <= 4) return;
    const atBottom = board.scrollTop + board.clientHeight >= board.scrollHeight - 4;
    if (atBottom) board.scrollTo({ top: 0, behavior: "smooth" });
    else board.scrollBy({ top: Math.round(board.clientHeight * 0.85), behavior: "smooth" });
  }, 5000);
}

// --- poll fallback ---------------------------------------------------------
async function poll() {
  const recent = await fetchRecent(20);
  recent.reverse().forEach((r) => enqueue(r));
}

// --- clock -----------------------------------------------------------------
function startClock() {
  const tick = () => {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

// --- QR "scan to play" -----------------------------------------------------
async function setupQR() {
  const urlEl = document.getElementById("qr-url");
  const codeEl = document.getElementById("qr-code");
  const toggle = document.getElementById("qr-toggle");
  const panel = document.getElementById("qr-panel");
  urlEl.textContent = PLAY_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    const px = Math.max(160, Math.round(window.innerHeight * 0.22));
    const canvas = document.createElement("canvas");
    await QRCode.toCanvas(canvas, PLAY_URL, {
      width: px,
      margin: 1,
      color: { dark: "#04140a", light: "#e9fff0" },
    });
    codeEl.append(canvas);
  } catch {
    codeEl.textContent = "QR unavailable";
  }
  toggle.addEventListener("click", () => {
    const show = panel.hidden;
    panel.hidden = !show;
    toggle.classList.toggle("on", show);
  });
}

// --- init ------------------------------------------------------------------
async function init() {
  startClock();
  setupQR();
  if (!enabled) {
    emptyEl.textContent = "Supabase not configured — set VITE_SUPABASE_* env vars.";
    emptyEl.classList.remove("hide");
    return;
  }
  const [top, recent, count] = await Promise.all([
    fetchTop(MAX),
    fetchRecent(50),
    fetchCount(),
  ]);
  countExact = count;
  const map = new Map();
  for (const r of [...top, ...recent]) {
    map.set(r.id, r);
    seen.add(r.id);
  }
  all = [...map.values()];
  renderAll();
  updateCount();
  staggerEntrance();
  startAutoScroll();

  subscribe({
    onInsert: enqueue,
    onDelete: handleDelete,
    onStatus: (s) => {
      if (s === "SUBSCRIBED") setTicker("▸ realtime online — waiting for the next escape…");
    },
  });
  setInterval(poll, 12000);
}

init();
