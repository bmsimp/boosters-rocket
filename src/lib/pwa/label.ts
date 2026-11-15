/** The longest name a phone shows whole under a home-screen icon; a longer one is cut off with "…". */
export const LABEL_MAX = 12;

/**
 * The words under the icon: the club's name when it fits, else its short name. Used for the manifest's short_name
 * and for iOS (apple-mobile-web-app-title), so both home screens say the same thing.
 */
export function appLabel(club: { name: string; shortName: string }): string {
  const name = club.name.trim(), short = club.shortName.trim();
  return [...name].length <= LABEL_MAX || !short ? name : short;
}
