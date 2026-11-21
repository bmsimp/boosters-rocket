"use server";
import { parentAction } from "@/lib/guards";
import { declinePasskeyOffer } from "@/lib/parents/passkey-offer";

/**
 * "Not now" on the passkey offer on Home (the sign-in release, slice SI-8; src/lib/parents/passkey-offer.ts). It takes
 * no argument at all: whose answer it is, and which device it is kept against, come from the session alone. It
 * revalidates nothing: the box replaces itself with the answer, and Home drawn again would take the box, and the
 * answer with it, away before the parent had read it.
 */
export const declinePasskeyOfferAction = parentAction(async (ctx) => declinePasskeyOffer(ctx));
