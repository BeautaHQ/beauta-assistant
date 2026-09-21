/** `npx tsx src/dev/tool.ts check_availability '{"serviceId":5,"date":"2026-09-22"}'` */
import { getCatalogue } from "../salon/catalogue";
import { salonForCall } from "../salon/lookup";
import { newSession } from "../call/session";
import { runTool } from "../receptionist/tools";

const [name, args] = process.argv.slice(2);

const run = async () => {
  const { salon } = await salonForCall(process.env.VOICE_TO ?? null, null);
  const session = newSession("cnv_dev_tool", "+61400111222", salon, "PHONE");
  session.catalogue = await getCatalogue(salon.organizationId);
  console.log(await runTool(name!, JSON.parse(args || "{}"), session));
};

void run();
