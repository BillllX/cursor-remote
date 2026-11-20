import type { NextRequest } from "next/server";
import { projectProxy } from "@/lib/projects/httpProxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  try {
    return await projectProxy(req, (await ctx.params).workspaceId, "media");
  } catch {
    return new Response(null, { status: 502 });
  }
}
