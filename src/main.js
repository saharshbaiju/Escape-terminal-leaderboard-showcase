// Realtime leaderboard showcase. New runs arrive via Supabase realtime (with a
// polling fallback), pop up as a hero card, then hop down the ranks into their
// sorted position while the other rows slide to make room (FLIP).
import "./style.css";
import {
  enabled,
  fetchTop,
  fetchRecent,
  fetchCount,
  subscribe,
} from "./supabase.js";

const N = parseInt(import.meta.env.VITE_TOP_N || "10", 10); // rows shown on the TV
const MAX = 100; // how many we keep in memory for correct ranking

const board = document.getElementById("board");
const heroLayer = document.getElementById("hero-layer");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const tickerEl = document.getElementById("ticker");

let all = []; // every known run (unsorted; sortAll() orders it)
let countExact = 0;
const seen = new Set(); // ids we've already accounted for
const queue = []; // pending new runs to animate
let busy = false;

// --- helpers ---------------------------------------------------------------
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
function setTicker(text) {
  tickerEl.textContent = text;
}

function makeRow(r, i) {
  const row = document.createElement("div");
  row.className = "row" + (i < 3 ? " rank-" + (i + 1) : "");
  row.dataset.id = r.id;
  row.innerHTML =
    `<div class="rank">#${i + 1}</div>` +
    `<div class="handle"></div>` +
    `<div class="badge ${badgeClass(r.outcome)}"></div>` +
    `<div class="score">${r.score}</div>` +
    `<div class="time">${fmtTime(r.total_seconds)}</div>`;
  row.querySelector(".handle").textContent = r.name;
  row.querySelector(".badge").textContent = r.outcome;
  return row;
}

// Plain render (initial load + after a delete). No hop animation.
function renderPlain() {
  sortAll();
  const display = all.slice(0, N);
  board.innerHTML = "";
  display.forEach((r, i) => board.append(makeRow(r, i)));
  updateEmpty();
}

function staggerEntrance() {
  [...board.children].forEach((e, i) => {
    e.animate(
      [
        { opacity: 0, transform: "translateY(24px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 450, delay: i * 70, easing: "ease-out", fill: "backwards" },
    );
  });
}

// --- the show: hero card, then hop into rank -------------------------------
function countUp(node, to, dur) {
  const start = performance.now();
  function step(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 0.5 - Math.cos(p * Math.PI) / 2; // ease-in-out
    node.textContent = Math.round(to * eased);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function hero(row, globalRank) {
  return new Promise((resolve) => {
    const card = document.createElement("div");
    card.className = "hero-card";
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

// Animate the new row from the #1 slot down to its rank, hopping past each row.
function descendAnimate(rowEl, targetIndex, rowStep) {
  if (targetIndex <= 0 || rowStep <= 0) {
    rowEl.animate(
      [{ transform: "scale(1.25)" }, { transform: "scale(1)" }],
      { duration: 650, easing: "cubic-bezier(.34,1.56,.64,1)" },
    );
    return;
  }
  rowEl.classList.add("row-descending");
  const steps = targetIndex;
  const frames = [];
  for (let k = 0; k <= steps; k++) {
    const y = -(steps - k) * rowStep; // starts at -steps*rowStep (top), ends 0
    frames.push({ transform: `translateY(${y}px) scale(1.12)`, offset: k / steps });
    if (k < steps) {
      const y0 = -(steps - k) * rowStep;
      const y1 = -(steps - (k + 1)) * rowStep;
      const yMid = (y0 + y1) / 2 - rowStep * 0.55; // arc upward between ranks
      frames.push({ transform: `translateY(${yMid}px) scale(1.0)`, offset: (k + 0.5) / steps });
    }
  }
  const dur = Math.min(2200, Math.max(750, steps * 240));
  const anim = rowEl.animate(frames, { duration: dur, easing: "linear" });
  anim.onfinish = () => rowEl.classList.remove("row-descending");
}

function renderWithAnimation(display, newId, targetIndex) {
  // FLIP: remember where every current row is before we rebuild.
  const oldRects = new Map();
  [...board.children].forEach((ch) => {
    if (ch.dataset.id) oldRects.set(ch.dataset.id, ch.getBoundingClientRect());
  });

  board.innerHTML = "";
  const rowEls = display.map((r, i) => makeRow(r, i));
  rowEls.forEach((e) => board.append(e));
  updateEmpty();

  const rowStep =
    rowEls.length > 1
      ? rowEls[1].getBoundingClientRect().top - rowEls[0].getBoundingClientRect().top
      : rowEls[0]
        ? rowEls[0].getBoundingClientRect().height
        : 0;

  rowEls.forEach((e) => {
    const id = e.dataset.id;
    if (id === newId) {
      descendAnimate(e, targetIndex, rowStep);
      e.classList.add("row-new");
      setTimeout(() => e.classList.remove("row-new"), 7200);
    } else if (oldRects.has(id)) {
      const o = oldRects.get(id);
      const n = e.getBoundingClientRect();
      const dx = o.left - n.left;
      const dy = o.top - n.top;
      if (dx || dy) {
        e.animate(
          [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }],
          { duration: 650, easing: "cubic-bezier(.2,.85,.25,1)" },
        );
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
  const display = all.slice(0, N);
  const targetIndex = display.findIndex((r) => r.id === row.id);
  setTicker(`Latest escape  ▸  ${row.name} — ${row.outcome} — ${row.score} pts`);

  await hero(row, globalRank);
  if (targetIndex >= 0) renderWithAnimation(display, row.id, targetIndex);
}

function handleDelete(old) {
  if (!old) return;
  const i = all.findIndex((r) => r.id === old.id);
  if (i >= 0) all.splice(i, 1);
  seen.delete(old.id);
  countExact = Math.max(0, countExact - 1);
  renderPlain();
  updateCount();
}

// --- poll fallback (if realtime isn't enabled on the table) ----------------
async function poll() {
  const recent = await fetchRecent(20);
  // oldest-first so multiple new runs animate in arrival order
  recent.reverse().forEach((r) => enqueue(r));
}

// --- init ------------------------------------------------------------------
async function init() {
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
    seen.add(r.id); // seed so the first poll doesn't re-animate existing runs
  }
  all = [...map.values()];
  renderPlain();
  updateCount();
  staggerEntrance();

  subscribe({
    onInsert: enqueue,
    onDelete: handleDelete,
    onStatus: (s) => {
      if (s === "SUBSCRIBED") setTicker("● realtime connected — waiting for the next escape…");
    },
  });

  setInterval(poll, 12000); // safety net regardless of realtime status
}

init();
