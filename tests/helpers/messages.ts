import { db } from "@/lib/db/client";
import { clubMessage, messageRead, messageVersion } from "@/lib/db/schema";
import { seedStaff } from "./db";

/**
 * Club messages as staff post them (src/lib/messages/staff.ts writes the same rows): a message with its versions, each
 * a plain paragraph, posted by `postedBy`. Returns the message's id.
 */
export async function seedMessage(o: { postedBy: string; titles: string[]; text?: string; postedAt?: Date; deleted?: { by: string } }): Promise<string> {
  const [m] = await db.insert(clubMessage).values({ postedBy: o.postedBy, postedAt: o.postedAt ?? new Date(),
    ...(o.deleted ? { deletedAt: new Date(), deletedBy: o.deleted.by } : {}) }).returning({ id: clubMessage.id });
  await db.insert(messageVersion).values(o.titles.map((title, i) => ({
    messageId: m!.id, n: i + 1, title, savedAt: new Date(Date.now() + i * 60_000),
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `${o.text ?? "Practice news"} (version ${i + 1})` }] }] },
  })));
  return m!.id;
}

/** How a family's parent stands with the club's one message: the words their pages must show, and their own markers. */
export type FamilyMessages = { home: string[]; markers: string[] };

/**
 * For seedTwoFamilies(): one message the club posted, the same for every family, which family B's parent has read and
 * family A's hasn't. What is B's own is that read row: its id is B's marker (no page shows it), and A's Home must still
 * say the message is new to A. `messageId` and `staffId` (its poster) open the message and the poster's profile.
 */
export async function seedTwoFamilyMessages(bParentId: string): Promise<{ messageId: string; staffId: string; title: string; a: FamilyMessages; b: FamilyMessages }> {
  const poster = await seedStaff({ email: "messages.poster@club.example", name: "Marisol Messenger" });
  const title = "Clubhouse keys and the spring schedule";
  const messageId = await seedMessage({ postedBy: poster.id, titles: [title] });
  const [read] = await db.insert(messageRead).values({ messageId, parentId: bParentId, versionN: 1 }).returning({ id: messageRead.id });
  return {
    messageId, staffId: poster.id, title,
    a: { home: ["1 new message from the club", title], markers: [] },
    b: { home: ['href="/messages">Messages</a>'], markers: [read!.id] },
  };
}
