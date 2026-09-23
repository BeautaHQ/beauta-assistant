import { answerFaq } from "./intents/faq";
import { extractServices } from "./intents/service/createService";
import { extractStaffBlock } from "./intents/staff/createBlock";
import { extractWorkingHourOverride } from "./intents/calendar/createWorkingHourOverride";
import { extractStaff } from "./intents/staff/createStaff";
import { classifyOwnerRequest } from "./router/classify";
import type { OwnerAssistantRequest, OwnerAssistantResult } from "./types";

const emptyParameters = () => ({
  staffName: null, startDate: null, endDate: null, startTime: null, endTime: null, allDay: null, reason: null, services: [], workingHourOverride: null, staff: [],
});

export const askOwnerAssistant = async (input: OwnerAssistantRequest): Promise<OwnerAssistantResult> => {
  const route = await classifyOwnerRequest(input.message);

  if (route.intent === "FAQ") {
    const faq = await answerFaq(input, route.domain);
    return {
      ...route, action: "NONE", status: "ANSWERED", answer: faq.answer, steps: faq.steps,
      pageKey: faq.pageKey, confidence: Math.min(1, Math.max(0, Number(faq.confidence) || 0)),
      parameters: emptyParameters(), confirmationRequired: false,
    };
  }

  if (route.action === "CREATE_STAFF_BLOCK") {
    const block = await extractStaffBlock(input);
    const ready = Boolean(block.staffName && block.startDate && block.endDate && (block.allDay || (block.startTime && block.endTime)));
    return {
      intent: "ACTION", domain: "STAFF", action: route.action,
      status: ready ? "READY" : "NEEDS_CLARIFICATION", answer: block.answer, steps: [], pageKey: null,
      confidence: 1, parameters: {
        ...emptyParameters(), staffName: block.staffName, startDate: block.startDate,
        endDate: block.endDate, startTime: block.startTime, endTime: block.endTime,
        allDay: block.allDay, reason: block.reason,
      },
      confirmationRequired: ready,
    };
  }

  if (route.action === "CREATE_STAFF") {
    const extracted = await extractStaff(input);
    const ready = extracted.staff.length > 0 && extracted.staff.every((staff) => Boolean(staff.name?.trim()) && staff.workingHours.length === 7);
    return {
      intent: "ACTION", domain: "STAFF", action: route.action,
      status: ready ? "READY" : "NEEDS_CLARIFICATION", answer: extracted.answer, steps: [], pageKey: null,
      confidence: 1, parameters: { ...emptyParameters(), staff: extracted.staff }, confirmationRequired: ready,
    };
  }

  if (route.action === "CREATE_SERVICE") {
    const extracted = await extractServices(input);
    const ready = extracted.services.length > 0 && extracted.services.every((service) =>
      Boolean(service.name?.trim()) && service.durationMinutes != null && service.durationMinutes > 0 && service.price != null && service.price >= 0,
    );
    return {
      intent: "ACTION", domain: "SERVICE", action: route.action,
      status: ready ? "READY" : "NEEDS_CLARIFICATION", answer: extracted.answer, steps: [], pageKey: null,
      confidence: 1, parameters: { ...emptyParameters(), services: extracted.services }, confirmationRequired: ready,
    };
  }

  if (route.action === "CREATE_WORKING_HOUR_OVERRIDE") {
    const override = await extractWorkingHourOverride(input);
    const ready = Boolean(override.startDate && override.endDate && (override.isClosed || (override.openTime && override.closeTime)));
    return {
      intent: "ACTION", domain: "CALENDAR", action: route.action,
      status: ready ? "READY" : "NEEDS_CLARIFICATION", answer: override.answer, steps: [], pageKey: null,
      confidence: 1, parameters: { ...emptyParameters(), workingHourOverride: {
        startDate: override.startDate, endDate: override.endDate, isClosed: override.isClosed,
        openTime: override.openTime, closeTime: override.closeTime,
      } }, confirmationRequired: ready,
    };
  }

  return {
    ...route, status: "NEEDS_CLARIFICATION", answer: "I can't perform that action yet. I can still show you how to do it in Beauta.",
    steps: [], pageKey: null, confidence: 0, parameters: emptyParameters(), confirmationRequired: false,
  };
};
