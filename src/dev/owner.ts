import { askOwnerAssistant } from "../owner-assistant";
import { prisma } from "../clients/prisma";
/** Ask the owner assistant one thing: npx tsx src/dev/owner.ts "..." [organizationId=1] */
const main = async () => {
  const message = process.argv[2] ?? "";
  const organizationId = Number(process.argv[3]) || 1;
  const { timezone } = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
  const result = await askOwnerAssistant({
    organizationId, message, history: [], timezone,
    today: new Date().toLocaleDateString("en-CA", { timeZone: timezone }),
    pageGuides: [],
  } as never);
  console.log("ANSWER:", result.answer);
  console.log("DETAILS:", JSON.stringify(result.details));
  console.log("ACTIONS:", JSON.stringify(result.actions, null, 1));
  await prisma.$disconnect();
};
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
