import { describeWeek, isDate, isTime, outsideSalonHours, sameName, staffDayProblems, withDays } from "../../rules";
import { describeSalonWeek } from "../../rules";
import { effectiveSalonHours, refuse, tool, type Tool, type ToolContext } from "../../toolkit";
import type { CreateAddonAction, CreateServiceAction, CreateStaffAction, DayHours, OwnerAction, UpdateAddonAction, UpdateServiceAction } from "../../types";

const str = { type: "string" };
const nullableStr = { type: ["string", "null"] };
const int = { type: "integer" };
const bool = { type: "boolean" };
const ids = { type: "array", items: int };
const staffDays = { type: "array", items: {
  type: "object", additionalProperties: false, required: ["dayOfWeek", "startTime", "endTime", "isOff"],
  properties: { dayOfWeek: int, startTime: str, endTime: str, isOff: bool },
} };

const accept = ({ batch }: ToolContext, action: OwnerAction, extra: Record<string, unknown> = {}) => {
  batch.proposals.push(action);
  return { ok: true, proposed: action, ...extra };
};

/** Existing ids plus the temporary ids of things proposed earlier in this reply. */
const knownServiceIds = async ({ data, batch }: ToolContext) =>
  new Set([...(await data.services()).map((item) => item.id), ...batch.pending("CREATE_SERVICE").map((item) => item.tempId)]);
const knownAddonIds = async ({ data, batch }: ToolContext) =>
  new Set([...(await data.addons()).map((item) => item.id), ...batch.pending("CREATE_ADDON").map((item) => item.tempId)]);
const unknown = (values: number[], known: Set<number>) => values.filter((id) => !known.has(id));

const read: Tool[] = [
  tool("get_salon_working_hours", "The salon's regular opening hours per weekday (1=Monday ... 7=Sunday). Staff hours must fit inside these.", {},
    async (_args, context) => {
      const days = await effectiveSalonHours(context);
      return { week: describeSalonWeek(days), days };
    }),
  tool("list_staff", "Every staff member: id, name, phone, active flag, assigned service ids and addon ids, weekly working hours.", {},
    async (_args, { data }) => ({ staff: (await data.staff()).map((staff) => ({ ...staff, week: describeWeek(staff.workingHours) })) })),
  tool("list_services", "Every service: id, name, price, duration in minutes, status, group. Names are not unique.", {},
    async (_args, { data }) => ({ services: await data.services() })),
  tool("list_commission_rules", "Every commission rate in force: rule id, staff id, item type and id (null = the staff member's general rate) and percentage.", {},
    async (_args, { data }) => {
      const [rules, staff, services, addons] = await Promise.all([data.commissionRules(), data.staff(), data.services(), data.addons()]);
      return { rules: rules.map((rule) => ({
        ...rule,
        label: `${staff.find((row) => row.id === rule.staffId)?.name ?? "all staff"}: ${rule.itemType === "SERVICE" ? services.find((row) => row.id === rule.itemId)?.name ?? `service ${rule.itemId}`
          : rule.itemType === "ADDON" ? addons.find((row) => row.id === rule.itemId)?.name ?? `addon ${rule.itemId}` : "general rate"} ${rule.percentage}%`,
      })) };
    }),
  tool("list_addons", "Every addon: id, name, price, duration in minutes, and the ids of the services it is attached to. Names are not unique.", {},
    async (_args, { data }) => ({ addons: await data.addons() })),
];

const propose: Tool[] = [
  tool("propose_create_services", "Propose creating services. Returns a temporary negative id per service for use in later proposals in this reply.", {
    services: { type: "array", minItems: 1, maxItems: 30, items: {
      type: "object", additionalProperties: false, required: ["name", "description", "durationMinutes", "price", "status", "allowDuplicateName"],
      properties: {
        name: str, description: nullableStr, durationMinutes: int, price: { type: "number" },
        status: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
        allowDuplicateName: { type: "boolean", description: "true only when the owner confirmed they want another service with an existing name" },
      },
    } },
  }, async ({ services }, context) => {
    const items = services as (Omit<CreateServiceAction, "type" | "tempId"> & { allowDuplicateName: boolean })[];
    const existing = await context.data.services();
    const problems: string[] = [];
    items.forEach((item, index) => {
      const label = item.name?.trim() || `service ${index + 1}`;
      if (!item.name?.trim() || item.name.length > 200) problems.push(`${label}: a name up to 200 characters is required`);
      if (!Number.isInteger(item.durationMinutes) || item.durationMinutes <= 0 || item.durationMinutes > 1440) problems.push(`${label}: duration must be whole minutes, 1-1440`);
      if (!(item.price >= 0)) problems.push(`${label}: price must be 0 or more`);
      const repeated = items.some((other, otherIndex) => otherIndex < index && sameName(other.name, item.name))
        || context.batch.pending("CREATE_SERVICE").some((other) => sameName(other.name, item.name));
      if (repeated) problems.push(`${label}: proposed twice`);
      const clash = existing.filter((service) => sameName(service.name, item.name));
      if (clash.length && !item.allowDuplicateName) {
        problems.push(`${label}: the salon already has ${JSON.stringify(clash)}. Use it, or ask the owner whether they want another one and if so propose again with allowDuplicateName=true`);
      }
    });
    if (problems.length) return refuse(...problems);
    const created = items.map(({ allowDuplicateName: _ignored, ...item }) => {
      const action: CreateServiceAction = {
        type: "CREATE_SERVICE", tempId: context.batch.nextTempId(),
        name: item.name.trim(), description: item.description?.trim() || null, durationMinutes: item.durationMinutes, price: item.price, status: item.status,
      };
      context.batch.proposals.push(action);
      return { tempId: action.tempId, name: action.name };
    });
    return { ok: true, created };
  }),

  tool("propose_create_addon", "Propose creating one addon attached to services (existing ids or temporary ids from this reply). Returns a temporary negative id.", {
    name: str, description: nullableStr, durationMinutes: int, price: { type: "integer", description: "whole currency units" }, serviceIds: ids, allowDuplicateName: bool,
  }, async (args, context) => {
    const item = args as Omit<CreateAddonAction, "type" | "tempId"> & { allowDuplicateName: boolean };
    const problems: string[] = [];
    if (!item.name?.trim() || item.name.length > 200) problems.push("a name up to 200 characters is required");
    if (!Number.isInteger(item.durationMinutes) || item.durationMinutes < 0 || item.durationMinutes > 1440) problems.push("duration must be whole minutes, 0-1440");
    if (!Number.isInteger(item.price) || item.price < 0) problems.push("addon price must be a whole number, 0 or more");
    if (!item.serviceIds.length) problems.push("attach the addon to at least one service, or it can never be booked");
    const missing = unknown(item.serviceIds, await knownServiceIds(context));
    if (missing.length) problems.push(`unknown service ids ${missing.join(", ")}`);
    if (context.batch.pending("CREATE_ADDON").some((other) => sameName(other.name, item.name))) problems.push("proposed twice");
    const clash = (await context.data.addons()).filter((addon) => sameName(addon.name, item.name));
    if (clash.length && !item.allowDuplicateName) {
      problems.push(`the salon already has ${JSON.stringify(clash)}. Use it, or ask the owner whether they want another one and if so propose again with allowDuplicateName=true`);
    }
    if (problems.length) return refuse(...problems);
    const action: CreateAddonAction = {
      type: "CREATE_ADDON", tempId: context.batch.nextTempId(), name: item.name.trim(), description: item.description?.trim() || null,
      durationMinutes: item.durationMinutes, price: item.price, serviceIds: [...new Set(item.serviceIds)],
    };
    return accept(context, action, { tempId: action.tempId });
  }),

  tool("propose_update_service", "Propose changing an existing service. Pass null for every field that stays the same.", {
    serviceId: int, name: nullableStr, price: { type: ["number", "null"] }, durationMinutes: { type: ["integer", "null"] },
    status: { type: ["string", "null"], enum: ["PUBLIC", "PRIVATE", null] },
  }, async (args, context) => {
    const item = args as Omit<UpdateServiceAction, "type" | "serviceName">;
    const service = (await context.data.services()).find((row) => row.id === item.serviceId);
    if (!service) return refuse(`no service with id ${item.serviceId}; call list_services (a service created in this reply cannot be updated yet)`);
    const problems: string[] = [];
    if (item.name !== null && (!item.name.trim() || item.name.length > 200)) problems.push("a new name must be 1-200 characters");
    if (item.price !== null && !(item.price >= 0)) problems.push("price must be 0 or more");
    if (item.durationMinutes !== null && (!Number.isInteger(item.durationMinutes) || item.durationMinutes <= 0 || item.durationMinutes > 1440)) problems.push("duration must be whole minutes, 1-1440");
    // Keep only what really differs from the service now.
    const name = item.name !== null && item.name.trim() !== service.name ? item.name.trim() : null;
    const price = item.price !== null && item.price !== service.price ? item.price : null;
    const durationMinutes = item.durationMinutes !== null && item.durationMinutes !== service.durationMinutes ? item.durationMinutes : null;
    const status = item.status !== null && item.status !== service.status ? item.status : null;
    if (!problems.length && name === null && price === null && durationMinutes === null && status === null) problems.push(`${service.name} already has exactly these values; nothing would change`);
    if (problems.length) return refuse(...problems);
    return accept(context, { type: "UPDATE_SERVICE", serviceId: service.id, serviceName: service.name, name, price, durationMinutes, status }, {
      before: { name: service.name, price: service.price, durationMinutes: service.durationMinutes, status: service.status },
    });
  }),

  tool("propose_update_addon", "Propose changing an existing addon: name, price, duration (null keeps the current value), and services to attach it to or detach it from (existing ids or temporary ids from this reply).", {
    addonId: int, name: nullableStr, price: { type: ["integer", "null"], description: "whole currency units" }, durationMinutes: { type: ["integer", "null"] },
    attachServiceIds: ids, detachServiceIds: ids,
  }, async (args, context) => {
    const item = args as Omit<UpdateAddonAction, "type" | "addonName">;
    const addon = (await context.data.addons()).find((row) => row.id === item.addonId);
    if (!addon) return refuse(`no addon with id ${item.addonId}; call list_addons (an addon created in this reply cannot be updated yet)`);
    const problems: string[] = [];
    if (item.name !== null && (!item.name.trim() || item.name.length > 200)) problems.push("a new name must be 1-200 characters");
    if (item.price !== null && (!Number.isInteger(item.price) || item.price < 0)) problems.push("addon price must be a whole number, 0 or more");
    if (item.durationMinutes !== null && (!Number.isInteger(item.durationMinutes) || item.durationMinutes < 0 || item.durationMinutes > 1440)) problems.push("duration must be whole minutes, 0-1440");
    const missing = unknown([...item.attachServiceIds, ...item.detachServiceIds], await knownServiceIds(context));
    if (missing.length) problems.push(`unknown service ids ${missing.join(", ")}`);
    const name = item.name !== null && item.name.trim() !== addon.name ? item.name.trim() : null;
    const price = item.price !== null && item.price !== addon.price ? item.price : null;
    const durationMinutes = item.durationMinutes !== null && item.durationMinutes !== addon.durationMinutes ? item.durationMinutes : null;
    const attachServiceIds = [...new Set(item.attachServiceIds)].filter((id) => !addon.serviceIds.includes(id));
    const detachServiceIds = [...new Set(item.detachServiceIds)].filter((id) => addon.serviceIds.includes(id));
    if (!problems.length && name === null && price === null && durationMinutes === null && !attachServiceIds.length && !detachServiceIds.length) {
      problems.push(`${addon.name} already has exactly this; nothing would change`);
    }
    if (problems.length) return refuse(...problems);
    const attachedAfter = [...addon.serviceIds.filter((id) => !detachServiceIds.includes(id)), ...attachServiceIds];
    return accept(context, { type: "UPDATE_ADDON", addonId: addon.id, addonName: addon.name, name, price, durationMinutes, attachServiceIds, detachServiceIds }, {
      before: { name: addon.name, price: addon.price, durationMinutes: addon.durationMinutes, serviceIds: addon.serviceIds },
      attachedServiceIdsAfter: attachedAfter,
      ...(attachedAfter.length ? {} : { note: "The addon would be attached to no services, so customers could never book it. Tell the owner." }),
    });
  }),

  tool("propose_create_staff", "Propose creating one staff member. workingHours lists all 7 days (1=Monday ... 7=Sunday). serviceIds and addonIds may include temporary ids from this reply. Returns a temporary negative id for the new staff member.", {
    name: str, phone: nullableStr, isActive: bool, serviceIds: ids, addonIds: ids, workingHours: staffDays,
  }, async (args, context) => {
    const item = args as { name: string; phone: string | null; isActive: boolean; serviceIds: number[]; addonIds: number[]; workingHours: DayHours[] };
    const name = item.name?.trim();
    const problems = staffDayProblems(item.workingHours, true);
    if (!name || name.length > 200) problems.push("a name up to 200 characters is required");
    else if ((await context.data.staff()).some((staff) => sameName(staff.name, name)) || context.batch.pending("CREATE_STAFF").some((staff) => sameName(staff.name, name))) {
      problems.push(`a staff member named ${name} already exists or is already proposed; to change them, update them instead`);
    }
    const badServices = unknown(item.serviceIds, await knownServiceIds(context));
    const badAddons = unknown(item.addonIds, await knownAddonIds(context));
    if (badServices.length) problems.push(`unknown service ids ${badServices.join(", ")}`);
    if (badAddons.length) problems.push(`unknown addon ids ${badAddons.join(", ")}`);
    if (!problems.length) problems.push(...outsideSalonHours(name!, item.workingHours, await effectiveSalonHours(context)));
    if (problems.length) return refuse(...problems);
    const action: CreateStaffAction = {
      type: "CREATE_STAFF", tempId: context.batch.nextTempId(), name: name!, phone: item.phone?.trim() || null, isActive: item.isActive,
      serviceIds: [...new Set(item.serviceIds)], addonIds: [...new Set(item.addonIds)],
      workingHours: [...item.workingHours].sort((a, b) => a.dayOfWeek - b.dayOfWeek),
    };
    return accept(context, action, {
      tempId: action.tempId,
      week: describeWeek(item.workingHours),
      ...(item.serviceIds.length ? {} : { note: "No services assigned: this staff member cannot be booked until they have some. Mention it to the owner." }),
    });
  }),

  tool("propose_update_staff", "Propose changing an existing staff member: add or remove services and addons, and/or change some days' hours (list only the days that change).", {
    staffId: int, addServiceIds: ids, removeServiceIds: ids, addAddonIds: ids, removeAddonIds: ids, workingHours: staffDays,
  }, async (args, context) => {
    const item = args as { staffId: number; addServiceIds: number[]; removeServiceIds: number[]; addAddonIds: number[]; removeAddonIds: number[]; workingHours: DayHours[] };
    const staff = (await context.data.staff()).find((row) => row.id === item.staffId);
    if (!staff) return refuse(`no staff member with id ${item.staffId}; call list_staff`);
    const problems = staffDayProblems(item.workingHours, false);
    const badServices = unknown([...item.addServiceIds, ...item.removeServiceIds], await knownServiceIds(context));
    const badAddons = unknown([...item.addAddonIds, ...item.removeAddonIds], await knownAddonIds(context));
    if (badServices.length) problems.push(`unknown service ids ${badServices.join(", ")}`);
    if (badAddons.length) problems.push(`unknown addon ids ${badAddons.join(", ")}`);
    const changedDays = item.workingHours.filter((day) => {
      const before = staff.workingHours.find((row) => row.dayOfWeek === day.dayOfWeek);
      return !before || before.isOff !== day.isOff || (!day.isOff && (before.startTime !== day.startTime || before.endTime !== day.endTime));
    });
    if (!problems.length) problems.push(...outsideSalonHours(staff.name, changedDays, await effectiveSalonHours(context)));
    const addServiceIds = [...new Set(item.addServiceIds)].filter((id) => !staff.serviceIds.includes(id));
    const removeServiceIds = [...new Set(item.removeServiceIds)].filter((id) => staff.serviceIds.includes(id));
    const addAddonIds = [...new Set(item.addAddonIds)].filter((id) => !staff.addonIds.includes(id));
    const removeAddonIds = [...new Set(item.removeAddonIds)].filter((id) => staff.addonIds.includes(id));
    if (!problems.length && !changedDays.length && !addServiceIds.length && !removeServiceIds.length && !addAddonIds.length && !removeAddonIds.length) {
      problems.push(`${staff.name} already has exactly this; nothing would change`);
    }
    if (problems.length) return refuse(...problems);
    return accept(context, {
      type: "UPDATE_STAFF", staffId: staff.id, staffName: staff.name,
      addServiceIds, removeServiceIds, addAddonIds, removeAddonIds, workingHours: changedDays,
    }, { changedDays: describeWeek(changedDays), weekAfterChange: describeWeek(withDays(staff.workingHours, changedDays)) });
  }),

  tool("propose_staff_block", "Propose time off for an existing staff member on specific dates (YYYY-MM-DD). allDay with null times for whole days.", {
    staffId: int, startDate: str, endDate: str, startTime: nullableStr, endTime: nullableStr, allDay: bool, reason: nullableStr,
  }, async (args, context) => {
    const item = args as { staffId: number; startDate: string; endDate: string; startTime: string | null; endTime: string | null; allDay: boolean; reason: string | null };
    const staff = (await context.data.staff()).find((row) => row.id === item.staffId);
    if (!staff) return refuse(`no staff member with id ${item.staffId}; call list_staff`);
    const problems: string[] = [];
    if (!isDate(item.startDate) || !isDate(item.endDate)) problems.push("dates must be YYYY-MM-DD");
    if (!item.allDay && (!isTime(item.startTime) || !isTime(item.endTime))) problems.push("a part-day block needs both times as HH:mm; ask the owner rather than guessing");
    const start = `${item.startDate} ${item.allDay ? "00:00" : item.startTime}`;
    const end = `${item.endDate} ${item.allDay ? "23:59" : item.endTime}`;
    if (!problems.length && start >= end) problems.push("the block must end after it starts");
    if (!problems.length && item.endDate < context.input.today) problems.push(`the block is entirely in the past (today is ${context.input.today})`);
    if (problems.length) return refuse(...problems);
    return accept(context, {
      type: "CREATE_STAFF_BLOCK", staffId: staff.id, staffName: staff.name, startDate: item.startDate, endDate: item.endDate,
      startTime: item.allDay ? null : item.startTime, endTime: item.allDay ? null : item.endTime, allDay: item.allDay, reason: item.reason?.trim() || null,
    });
  }),

  tool("propose_set_commission", "Propose a staff member's commission percentage (0-100): their general rate when itemType and itemId are null, or a rate for one service or addon. Replaces the current rate for that staff and item. staffId and itemId may be temporary ids from this reply.", {
    staffId: int, itemType: { type: ["string", "null"], enum: ["SERVICE", "ADDON", null] }, itemId: { type: ["integer", "null"] }, percentage: { type: "number" },
  }, async (args, context) => {
    const item = args as { staffId: number; itemType: "SERVICE" | "ADDON" | null; itemId: number | null; percentage: number };
    const staffName = (await context.data.staff()).find((row) => row.id === item.staffId)?.name
      ?? context.batch.pending("CREATE_STAFF").find((row) => row.tempId === item.staffId)?.name;
    if (!staffName) return refuse(`no staff member with id ${item.staffId}; call list_staff`);
    const problems: string[] = [];
    if (!(item.percentage >= 0 && item.percentage <= 100) || Math.round(item.percentage * 100) !== item.percentage * 100) problems.push("percentage must be 0-100 with at most 2 decimals");
    if ((item.itemType === null) !== (item.itemId === null)) problems.push("itemType and itemId go together: both null for the general rate, or both set");
    let itemName: string | null = null;
    if (item.itemType === "SERVICE" && item.itemId !== null) {
      itemName = (await context.data.services()).find((row) => row.id === item.itemId)?.name
        ?? context.batch.pending("CREATE_SERVICE").find((row) => row.tempId === item.itemId)?.name ?? null;
      if (!itemName) problems.push(`no service with id ${item.itemId}`);
    }
    if (item.itemType === "ADDON" && item.itemId !== null) {
      itemName = (await context.data.addons()).find((row) => row.id === item.itemId)?.name
        ?? context.batch.pending("CREATE_ADDON").find((row) => row.tempId === item.itemId)?.name ?? null;
      if (!itemName) problems.push(`no addon with id ${item.itemId}`);
    }
    const sameTarget = (rule: { staffId: number | null; itemType: string | null; itemId: number | null }) =>
      rule.staffId === item.staffId && rule.itemType === item.itemType && rule.itemId === item.itemId;
    const current = (await context.data.commissionRules()).find(sameTarget);
    if (!problems.length && current && current.percentage === item.percentage) problems.push(`${staffName} already has ${item.percentage}% for this; nothing would change`);
    if (context.batch.pending("SET_COMMISSION").some(sameTarget)) problems.push("a rate for this staff and item is already proposed");
    if (problems.length) return refuse(...problems);
    return accept(context, {
      type: "SET_COMMISSION", staffId: item.staffId, staffName, itemType: item.itemType, itemId: item.itemId, itemName, percentage: item.percentage,
    }, { before: current ? `${current.percentage}%` : "no rate of its own yet" });
  }),

  tool("propose_remove_commission", "Propose removing an active commission rate by its rule id (from list_commission_rules). A single-item rate falls back to the staff member's general rate.", {
    ruleId: int,
  }, async ({ ruleId }, context) => {
    const rules = await context.data.commissionRules();
    const rule = rules.find((row) => row.id === ruleId);
    if (!rule) return refuse(`no active commission rule with id ${String(ruleId)}; call list_commission_rules`);
    if (context.batch.pending("REMOVE_COMMISSION").some((row) => row.ruleId === rule.id)) return refuse("already proposed");
    const staffName = (await context.data.staff()).find((row) => row.id === rule.staffId)?.name ?? "all staff";
    const itemName = rule.itemType === "SERVICE" ? (await context.data.services()).find((row) => row.id === rule.itemId)?.name ?? `service ${rule.itemId}`
      : rule.itemType === "ADDON" ? (await context.data.addons()).find((row) => row.id === rule.itemId)?.name ?? `addon ${rule.itemId}` : null;
    const general = rules.find((row) => row.staffId === rule.staffId && row.itemType === null && row.id !== rule.id);
    return accept(context, { type: "REMOVE_COMMISSION", ruleId: rule.id, staffName, itemName, percentage: rule.percentage }, {
      afterwards: itemName ? (general ? `falls back to ${staffName}'s general rate of ${general.percentage}%` : `${staffName} has no general rate, so this earns no commission`)
        : `${staffName} has no general rate any more; only their single-item rates remain`,
    });
  }),
];

export const catalogTools = [...read, ...propose];
