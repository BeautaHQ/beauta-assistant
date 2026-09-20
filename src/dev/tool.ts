/** `npx tsx src/dev/tool.ts check_availability '{"serviceId":5,"date":"2026-09-22"}'` */
import { getCatalogue } from "../catalogue";
import { salonForCall } from "../salon";
import { newSession } from "../session";
import { runTool } from "../tools";

const [name, args] = process.argv.slice(2);

const run = async () => {
  const { salon } = await salonForCall(process.env.VOICE_TO ?? null, null);
  const session = newSession("DEV_TOOL", "+61400111222", salon);
  session.catalogue = await getCatalogue(salon.organizationId);
  console.log(await runTool(name!, JSON.parse(args || "{}"), session));
};

void run();
