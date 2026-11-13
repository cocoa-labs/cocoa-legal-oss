import { createClient } from "@supabase/supabase-js";
import { installSupabaseAuthErrorFilter } from "@/lib/silenceSupabaseAuthNoise";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    "";

// Drop the benign "Failed to fetch" console.error auth-js emits on transient,
// auto-retried background token refreshes (see silenceSupabaseAuthNoise). Runs
// once on the client, before AuthContext starts using the client below.
installSupabaseAuthErrorFilter();

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
