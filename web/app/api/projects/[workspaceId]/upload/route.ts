import type { NextRequest } from "next/server";
import { projectProxy } from "@/lib/projects/httpProxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  try {
    return await projectProxy(req, (await ctx.params).workspaceId, "upload");
  } catch {
    return new Response(null, { status: 502 });
  }
}
