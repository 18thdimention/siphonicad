import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-side Supabase client using the service role key.
// IMPORTANT: SUPABASE_SERVICE_ROLE_KEY must NEVER be exposed to the browser.
// Set it only in server-side env (e.g. .env.local, not NEXT_PUBLIC_...).

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabaseAdmin: SupabaseClient | null = null;

if (!supabaseUrl || !serviceRoleKey) {
  console.warn(
    "Supabase admin client is not configured. NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in the environment.",
  );
} else {
  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { supabaseAdmin };
