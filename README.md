# Escape the Terminal — Leaderboard TV showcase

A full-screen, realtime leaderboard meant to run on a **TV at the stall**. Same
green-phosphor CRT theme as the game. When someone finishes a run, it:

1. **pops up as a hero card** in the centre (name, outcome, score count-up, rank),
2. then the card flies into the board and the new row **hops down the ranks** to
   its sorted position while the other rows slide to make room (FLIP animation),
3. and glows for a few seconds so everyone sees who just landed.

It reads the **same Supabase `leaderboard` table** the game writes to — no
backend, deploys to Vercel as a static site.

```
leaderboard-tv/
  index.html
  src/
    main.js       realtime + hero card + hop-into-rank animation
    style.css     CRT theme, scales to any screen via one --u (vh) knob
    supabase.js   client, fetch, realtime subscription
```

## Run locally

```bash
cd leaderboard-tv
npm install
npm run dev        # open the printed URL, press F11 for full-screen
```

Uses `.env.local` (already points at the project). On the actual TV: open the
deployed URL in a browser and go full-screen (F11 / kiosk mode).

## Enable realtime (one-time, recommended)

The poll fallback updates every ~12s on its own, but for **instant** pop-ups add
the table to Supabase's realtime publication. Run once in the SQL Editor:

```sql
alter publication supabase_realtime add table public.leaderboard;
```

(RLS already allows anon `select`, which realtime requires.) That's the only
extra setup beyond the game's table migration.

## Deploy to Vercel

Import the repo as a **separate Vercel project**, set **Root Directory** to
`leaderboard-tv`, and add the env vars:

| Name | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | your Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | publishable key (`sb_publishable_…`) |
| `VITE_SUPABASE_TABLE` | `leaderboard` (optional) |
| `VITE_TOP_N` | how many rows to show (optional, default `10`) |

## Notes

- It keeps the top 100 in memory for correct ranking but shows `VITE_TOP_N` rows.
- Every finisher gets a hero card even if their score doesn't make the visible
  top-N (the card shows their real overall rank).
- Admin deletes (from the desktop TUI) are reflected live too.
- Tune the look with one number: `--u` in `style.css` scales the whole UI.
