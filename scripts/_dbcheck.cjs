const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const subs = await p.subscription.findMany({
    orderBy: { updatedAt: "desc" },
    take: 3,
  });
  console.log("=== SUBSCRIPTIONS ===");
  for (const s of subs) {
    console.log(
      JSON.stringify({
        id: s.id,
        userId: s.userId,
        plan: s.plan,
        interval: s.interval,
        status: s.status,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        amountMinorUnits: s.amountMinorUnits,
        updatedAt: s.updatedAt,
      })
    );
  }

  const logs = await p.paymentLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  console.log("=== PAYMENT LOG (newest first) ===");
  for (const l of logs) {
    console.log(
      JSON.stringify({
        stage: l.stage,
        createdAt: l.createdAt,
        errorReason: l.errorReason,
        flutterwaveEventId: l.flutterwaveEventId ?? null,
      })
    );
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
