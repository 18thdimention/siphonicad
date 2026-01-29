"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(true);
  const hasRedirected = useRef(false);

  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    async function redirectUser(user: any) {
      if (hasRedirected.current) return;
      hasRedirected.current = true;

      try {
        // Get organization_code from user metadata (stored during login)
        const organizationCode = user.user_metadata?.organization_code;

        if (organizationCode) {
          // Persist the org so navigation can stay org-aware on non-org routes
          if (typeof window !== "undefined") {
            window.localStorage.setItem("currentOrgId", String(organizationCode));
          }

          // Redirect to the organization page using the organization code as orgId
          router.push(`/orgs/${organizationCode}`);
        } else {
          // Fallback: try to get organization from organization_members table
          const { data: orgMembership, error: orgError } = await supabase
            .from("organization_members")
            .select("organization_id")
            .eq("user_id", user.id)
            .single();

          if (orgError && orgError.code !== "PGRST116") {
            console.error("Error fetching organization:", orgError);
          }

          if (orgMembership?.organization_id) {
            // Persist the org so navigation can stay org-aware on non-org routes
            if (typeof window !== "undefined") {
              window.localStorage.setItem(
                "currentOrgId",
                String(orgMembership.organization_id),
              );
            }

            router.push(`/orgs/${orgMembership.organization_id}`);
          } else {
            // If no organization found, redirect to dashboard
            console.warn("No organization found for user, redirecting to dashboard");
            router.push("/dashboard");
          }
        }
      } catch (error) {
        console.error("Error redirecting user:", error);
        router.push("/dashboard");
      } finally {
        setLoading(false);
        if (subscription) {
          subscription.unsubscribe();
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    async function handleAuth() {
      try {
        // Newer Supabase magic link flows (PKCE) redirect with a `code` query param.
        // Try exchanging it for a session first if present.
        const code = searchParams.get("code");

        if (code && !hasRedirected.current) {
          const { data, error } = await supabase.auth.exchangeCodeForSession(code);

          if (error) {
            console.error("Error exchanging auth code for session:", error);
          } else if (data.session?.user) {
            await redirectUser(data.session.user);
            return;
          }
        }

        // For implicit-flow magic links, Supabase automatically processes URL hash
        // fragments when getSession() is called. The hash contains access_token, etc.
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
          console.error("Error getting session:", sessionError);
          router.push("/login");
          setLoading(false);
          return;
        }

        if (session?.user) {
          // Session exists, redirect user
          await redirectUser(session.user);
          return;
        }

        // If no session yet, set up auth state listener to catch when session is established
        // This handles cases where URL hash processing takes a moment
        const { data: { subscription: authSubscription } } = supabase.auth.onAuthStateChange(
          async (event, session) => {
            if (event === "SIGNED_IN" && session?.user && !hasRedirected.current) {
              await redirectUser(session.user);
            } else if (event === "SIGNED_OUT" && !hasRedirected.current) {
              router.push("/login");
              setLoading(false);
            }
          }
        );

        subscription = authSubscription;

        // Fallback: check again after a delay in case the session was established
        // but the auth state change event hasn't fired yet
        timeoutId = setTimeout(async () => {
          if (!hasRedirected.current) {
            const { data: { session: delayedSession } } = await supabase.auth.getSession();
            if (delayedSession?.user) {
              await redirectUser(delayedSession.user);
            } else {
              // No session after delay, redirect to login
              router.push("/login");
              setLoading(false);
              if (subscription) {
                subscription.unsubscribe();
              }
            }
          }
        }, 1000);

      } catch (error) {
        console.error("Auth error:", error);
        router.push("/login");
        setLoading(false);
      }
    }

    handleAuth();

    return () => {
      hasRedirected.current = true;
      if (subscription) {
        subscription.unsubscribe();
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [router, searchParams]);

  return (
    <div className="flex items-center justify-center h-screen text-muted-foreground">
      {loading ? "Logging you in..." : "Redirecting..."}
    </div>
  );
}

export default function AuthCallback() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        Checking your login status...
      </div>
    }>
      <AuthCallbackInner />
    </Suspense>
  );
}
