import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL || "";
const KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "";
export const TABLE = import.meta.env.VITE_SUPABASE_TABLE || "leaderboard";

export const supabase = URL && KEY ? createClient(URL, KEY) : null;
export const enabled = Boolean(supabase);

// Top runs, sorted exactly like the in-game board (score desc, then fastest).
export async function fetchTop(limit = 50) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("score", { ascending: false })
    .order("total_seconds", { ascending: true })
    .limit(limit);
  return error ? [] : data || [];
}

// Exact total run count (for the header).
export async function fetchCount() {
  if (!supabase) return 0;
  const { count } = await supabase
    .from(TABLE)
    .select("*", { count: "exact", head: true });
  return count || 0;
}

// Most recent arrivals regardless of score — used by the poll fallback so new
// runs still animate even if realtime isn't enabled on the table.
export async function fetchRecent(limit = 20) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return error ? [] : data || [];
}

// Realtime: fire onInsert/onDelete as rows change. Returns the channel.
export function subscribe({ onInsert, onDelete, onStatus }) {
  if (!supabase) return null;
  const channel = supabase
    .channel("leaderboard-tv")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: TABLE },
      (payload) => onInsert && onInsert(payload.new),
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: TABLE },
      (payload) => onDelete && onDelete(payload.old),
    )
    .subscribe((status) => onStatus && onStatus(status));
  return channel;
}
