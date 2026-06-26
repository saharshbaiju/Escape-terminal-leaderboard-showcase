// Realtime leaderboard for a stall TV. Solid/flat design (no CRT). New runs
// arrive via Supabase realtime (+ polling fallback), flash a card, then take a
// top-3 badge seat or hop into the ranked list. Top 3 stay pinned.
import "./style.css";
import {
  enabled,
  fetchTop,
  fetchRecent,
  fetchCount,
  subscribe,
} from "./supabase.js";
import { TITLE } from "./art.js";
import QRCode from "qrcode";

const RAW_N = import.meta.env.VITE_TOP_N;
const N = RAW_N && parseInt(RAW_N, 10) > 0 ? parseInt(RAW_N, 10) : Infinity;
const MAX = 500;
const PLAY_URL = import.meta.env.VITE_PLAY_URL || "https://escapeterminal.vercel.app/";

const titleEl = document.getElementById("title");
const top3El = document.getElementById("top3");
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

const RANK_CLASS = ["gold", "silver", "bronze"];

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
function updateCount() {
  countEl.textContent = `${countExact} run${countExact === 1 ? "" : "s"}`;
}
function updateEmpty() {
  emptyEl.classList.toggle("hide", all.length > 0 || !enabled);
}
function setTicker(t) {
  tickerEl.textContent = t;
}

// --- title (ASCII block, fit to width) -------------------------------------
function fitTitle() {
  titleEl.textContent = TITLE;
  titleEl.style.fontSize = "10px"; // measure at a known size, then scale
  const avail = titleEl.clientWidth;
  const natural = titleEl.scrollWidth;
  if (natural > 0 && avail > 0) {
    // target ~78% of the available width so the banner has breathing room
    titleEl.style.fontSize = `${Math.max(6, Math.floor((10 * avail * 0.78) / natural))}px`;
  }
}

// --- top 3 (pinned, badge rows) --------------------------------------------
function makeTop3Row(r, rankIdx) {
  const row = el("div", "trow t" + (rankIdx + 1));
  row.dataset.id = r.id;
  row.append(el("div", "rbadge " + RANK_CLASS[rankIdx], String(rankIdx + 1)));
  row.append(el("div", "t-handle", r.name));
  const badge = el("div", "badge " + badgeClass(r.outcome));
  badge.textContent = r.outcome;
  row.append(badge);
  row.append(el("div", "t-score", String(r.score)));
  row.append(el("div", "t-time", fmtTime(r.total_seconds)));
  return row;
}
function renderTop3(newId) {
  const top3 = all.slice(0, 3);
  top3El.innerHTML = "";
  top3.forEach((r, i) => {
    const row = makeTop3Row(r, i);
    top3El.append(row);
    if (r.id === newId) {
      row.animate(
        [{ opacity: 0, transform: "translateX(-12px)" }, { opacity: 1, transform: "none" }],
        { duration: 450, easing: "ease-out" },
      );
    }
  });
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
      setTimeout(() => e.classList.remove("row-new"), 5000);
    } else if (oldTops.has(id)) {
      const dy = oldTops.get(id) - e.offsetTop;
      if (dy) {
        e.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
          duration: 600,
          easing: "cubic-bezier(.2,.85,.25,1)",
        });
      }
    } else {
      e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: "ease-out" });
    }
  });
}
function descendAnimate(rowEl, targetIndex, rowStep) {
  if (targetIndex <= 0 || rowStep <= 0) return;
  const steps = Math.min(targetIndex, 8);
  const frames = [];
  for (let k = 0; k <= steps; k++) {
    const y = -(steps - k) * rowStep;
    frames.push({ transform: `translateY(${y}px)`, offset: k / steps });
    if (k < steps) {
      const y0 = -(steps - k) * rowStep;
      const y1 = -(steps - (k + 1)) * rowStep;
      const yMid = (y0 + y1) / 2 - rowStep * 0.4;
      frames.push({ transform: `translateY(${yMid}px)`, offset: (k + 0.5) / steps });
    }
  }
  const dur = Math.min(2000, Math.max(700, steps * 220));
  rowEl.animate(frames, { duration: dur, easing: "linear" });
}

function renderAll() {
  sortAll();
  renderTop3(null);
  renderListPlain();
}

// --- new-run card ----------------------------------------------------------
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
        { opacity: 0, transform: "scale(.85)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 350, easing: "ease-out", fill: "forwards" },
    );
    countUp(card.querySelector("#hv-score"), row.score, 800);
    setTimeout(() => {
      const out = card.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 400,
        easing: "ease-in",
        fill: "forwards",
      });
      out.onfinish = () => {
        card.remove();
        resolve();
      };
    }, 2000);
  });
}

// --- queue -----------------------------------------------------------------
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
  setTicker(`${row.name} escaped — ${row.outcome} · ${row.score} pts · #${globalRank + 1}`);
  await hero(row, globalRank);
  if (globalRank < 3) {
    renderTop3(row.id);
    renderListWithAnimation(null);
  } else {
    renderTop3(null);
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

// --- auto-scroll -----------------------------------------------------------
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

async function poll() {
  const recent = await fetchRecent(20);
  recent.reverse().forEach((r) => enqueue(r));
}

function startClock() {
  const tick = () => {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
  };
  tick();
  setInterval(tick, 1000);
}

async function setupQR() {
  const urlEl = document.getElementById("qr-url");
  const codeEl = document.getElementById("qr-code");
  const toggle = document.getElementById("qr-toggle");
  const panel = document.getElementById("qr-panel");
  urlEl.textContent = PLAY_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    const px = Math.max(150, Math.round(window.innerHeight * 0.2));
    const canvas = document.createElement("canvas");
    await QRCode.toCanvas(canvas, PLAY_URL, {
      width: px,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
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
  fitTitle();
  window.addEventListener("resize", fitTitle);
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
  startAutoScroll();

  subscribe({
    onInsert: enqueue,
    onDelete: handleDelete,
    onStatus: (s) => {
      if (s === "SUBSCRIBED") setTicker("Connected — waiting for the next escape");
    },
  });
  setInterval(poll, 12000);
}

init();
