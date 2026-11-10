import { can, type Effective } from "@/lib/permissions/effective";

/** Staff with mail or settings access see the mail warning (spec §3 When a send fails). */
export const seesMailWarning = (e: Effective) =>
  can(e, "Settings.Mail.ReadWrite") || can(e, "Settings.Club.Read") || can(e, "Settings.SignIn.ReadWrite");
