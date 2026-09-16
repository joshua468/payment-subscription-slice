import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getSubscriptionState } from "@/lib/subscription/service";

export async function GET() {
  try {
    const user = await getCurrentUser();
    const state = await getSubscriptionState(user.id);
    return NextResponse.json(state);
  } catch {
    return NextResponse.json(
      { subscription: null, latestStage: null },
      { status: 200 }
    );
  }
}

export const dynamic = "force-dynamic";