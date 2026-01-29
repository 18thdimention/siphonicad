"use client";
import react, { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { LoginForm } from '@/components/login-form';

export default function login() {
  const [organization, setOrganization] = useState("");
  const [email, setEmail] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    
    // Validate organization code and email, then send magic link
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        data: { organization_code: organization },
      },
    });
    
    if (error) {
      alert(error.message);
    } else {
      alert("Check your email for the login link!");
    }
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm
          organization={organization}
          email={email}
          onOrganizationChange={(e) => setOrganization(e.target.value)}
          onEmailChange={(e) => setEmail(e.target.value)}
          onSubmit={handleLogin}
        />
      </div>
    </div>
  )
}