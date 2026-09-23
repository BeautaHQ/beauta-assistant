export const OWNER_DOMAINS = [
  "BOOKING", "SERVICE", "STAFF", "CUSTOMER", "CALENDAR", "REPORTING",
  "SETTINGS", "SUPPORT", "OTHER",
] as const;

export type OwnerDomain = (typeof OWNER_DOMAINS)[number];
export type OwnerIntent = "FAQ" | "ACTION" | "CLARIFICATION";
export type OwnerAction = "CREATE_STAFF" | "CREATE_STAFF_BLOCK" | "CREATE_WORKING_HOUR_OVERRIDE" | "CREATE_SERVICE" | "NONE";

export type ServiceDraft = {
  name: string | null;
  description: string | null;
  durationMinutes: number | null;
  price: number | null;
  status: "PUBLIC" | "PRIVATE";
};

export type PageGuideInput = {
  key: string;
  page: string;
  summary: string;
  instructions: string;
};

export type OwnerAssistantRequest = {
  message: string;
  timezone: string;
  today: string;
  tomorrow: string;
  pageGuides: PageGuideInput[];
  ownerContext: {
    services: { id: number; name: string }[];
    addons: { id: number; name: string }[];
    salonWorkingHours: { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }[];
  };
};

export type StaffDraft = {
  name: string | null;
  phone: string | null;
  isActive: boolean;
  serviceNames: string[];
  addonNames: string[];
  workingHours: { dayOfWeek: number; startTime: string; endTime: string; isOff: boolean }[];
};

export type OwnerAssistantResult = {
  intent: OwnerIntent;
  domain: OwnerDomain;
  action: OwnerAction;
  status: "READY" | "NEEDS_CLARIFICATION" | "ANSWERED";
  answer: string;
  steps: string[];
  pageKey: string | null;
  confidence: number;
  parameters: {
    staffName: string | null;
    startDate: string | null;
    endDate: string | null;
    startTime: string | null;
    endTime: string | null;
    allDay: boolean | null;
    reason: string | null;
    services: ServiceDraft[];
    workingHourOverride: {
      startDate: string | null;
      endDate: string | null;
      isClosed: boolean;
      openTime: string | null;
      closeTime: string | null;
    } | null;
    staff: StaffDraft[];
  };
  confirmationRequired: boolean;
};
