const SAO_PAULO_OFFSET_HOURS = -3;

/**
 * Converts any parseable date (ISO with "Z", ISO with a numeric offset, or an RFC-822
 * `pubDate` from RSS) into an ISO string in the América/São_Paulo offset.
 *
 * Both football APIs speak UTC and the RSS feed speaks RFC-822; `src/generation/match-format.ts`
 * reads day/month/hour straight off the ISO string's digits instead of building a `Date` and
 * calling local getters (the fix from task 00's review, done precisely so the result doesn't
 * depend on the host machine's timezone). So the string leaving `src/sources/` needs to already
 * be in Brasília's offset, or every night match shows up on the wrong day.
 *
 * Implementation: fixed -3h offset arithmetic, formatted as "-03:00". Brazil has had no
 * daylight saving time since 2019, so there's no seasonal rule to get right — `Intl.DateTimeFormat`
 * would solve the general case, but for a fixed offset it's machinery the user doesn't need to
 * understand.
 */
export function toSaoPauloIso(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`not a valid date: ${input}`);
  }

  const shifted = new Date(date.getTime() + SAO_PAULO_OFFSET_HOURS * 60 * 60 * 1000);

  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}-03:00`;
}
