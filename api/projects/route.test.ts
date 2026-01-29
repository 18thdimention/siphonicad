import { describe, it, expect, vi } from "vitest";

// Mock supabaseAdmin to simulate it being uninitialized
vi.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: null,
}));

import { GET, POST } from "./route";

// Minimal Request stubs so handlers can read url / json without needing full Fetch API

describe("GET /api/projects", () => {
  it("returns 500 if supabaseAdmin is not initialized", async () => {
    const req = { url: "http://localhost/api/projects" } as Request;

    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Supabase admin client not initialized" });
  });
});

describe("POST /api/projects", () => {
  it("returns 500 if supabaseAdmin is not initialized", async () => {
    const payload = {
      name: "Test Project",
      organization_id: "org_123",
      user_id: "user_123",
    };

    const req = {
      json: async () => payload,
    } as unknown as Request;

    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Supabase admin client not initialized" });
  });
});
