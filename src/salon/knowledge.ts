import { prisma } from "../clients/prisma";
import { publicUrl } from "../config";

/**
 * The salon's reference photos — a price board, a parking sign, a style chart —
 * uploaded against its AI knowledge alongside the free-text `localKnowledge`.
 *
 * The model never sees the pixels. It is given the note the salon wrote and the
 * row's id, and nothing else: notes are what a question can be matched against,
 * and an id is small enough to be handed back without the model having to copy
 * a URL it would sooner or later get wrong. The URL is resolved here afterwards
 * from the id, so what the customer is shown is always a photo this salon
 * actually uploaded.
 *
 * Chat only. A photo is no use to someone on the phone.
 */
export interface KnowledgeImage {
  id: number;
  url: string;
  /** What the salon says the photo is. The only handle the model has on it. */
  note: string;
}

interface Cached {
  at: number;
  value: KnowledgeImage[];
}

/*
 * Shared across conversations, keyed by salon, exactly as the price list is:
 * a salon's photos are the same for everyone who opens the chat, and nothing
 * customer-specific lives here. Two salons on one instance must never be shown
 * each other's.
 */
const cached = new Map<number, Cached>();
const TTL_MS = 5 * 60 * 1000;

const build = async (organizationId: number): Promise<KnowledgeImage[]> => {
  const rows = await prisma.organizationKnowledgeImage.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, s3Key: true, note: true },
  });

  return rows.flatMap((row) => {
    /*
     * A photo with no note is dropped rather than listed as "(no description)".
     * The note is the whole of what the model has to go on — offered an
     * unnamed one it can only guess, and a guess here puts a stranger's nail
     * chart in front of someone who asked about parking.
     */
    const note = row.note?.trim();
    const url = publicUrl(row.s3Key);
    if (!note || !url) return [];
    return [{ id: row.id, url, note }];
  });
};

/**
 * This salon's photos, or none.
 *
 * Failures come back empty. The photos are a garnish on an answer that stands
 * up without them, so a database that blinks must cost the customer a picture
 * and not their reply.
 */
export const getKnowledgeImages = async (
  organizationId: number,
): Promise<KnowledgeImage[]> => {
  const hit = cached.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const value = await build(organizationId);
    cached.set(organizationId, { at: Date.now(), value });
    return value;
  } catch {
    return [];
  }
};

/**
 * The ids the model handed back, turned into the photos they name.
 *
 * Matched against the list this conversation was given rather than looked up
 * afresh: an id the model invented, or one belonging to another salon, names
 * nothing here and is simply dropped. Order follows the model's, because it
 * chose which photo answers best.
 */
export const imagesByIds = (
  images: KnowledgeImage[],
  ids: unknown,
): KnowledgeImage[] => {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const byId = new Map(images.map((image) => [image.id, image]));
  const seen = new Set<number>();

  return ids.flatMap((id) => {
    const image = typeof id === "number" ? byId.get(id) : undefined;
    if (!image || seen.has(image.id)) return [];
    seen.add(image.id);
    return [image];
  });
};
