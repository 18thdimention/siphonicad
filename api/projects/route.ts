import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const organizationId = searchParams.get("organization_id");

  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase admin client not initialized" }, { status: 500 });
  }
  let query = supabaseAdmin.from("projects").select("*").order("created_at", { ascending: false });
  
  if (organizationId) {
    query = query.eq("organization_id", organizationId);
  }

  const { data, error } = await query;
  
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  const body = await req.json();
  const { name, organization_id, user_id } = body;

  if (!organization_id) {
    return NextResponse.json({ error: "organization_id is required" }, { status: 400 });
  }

  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase admin client not initialized" }, { status: 500 });
  }
  const { data, error } = await supabaseAdmin
    .from("projects")
    .insert([{ name, organization_id, created_by: user_id }])
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}