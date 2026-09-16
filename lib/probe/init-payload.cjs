const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  const logs = await p.paymentLog.findMany({
    where: { stage: "initiation" },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  for (const l of logs) {
    const raw = l.rawWebhookPayload;
    console.log(
      JSON.stringify({
        createdAt: l.createdAt,
        txRef: raw?.txRef ?? null,
        flutterwavePaymentId: raw?.flutterwavePaymentId ?? null,
        interval: raw?.interval ?? null,
        amountMinorUnits: raw?.amountMinorUnits ?? null,
      })
    );
  }
  await p.$disconnect();
})().catch(async (e) => {
  console.error("ERR", e.message);
  await p.$disconnect();
  process.exit(1);
});
