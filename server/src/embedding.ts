/* Who is allowed to put nightraze inside their page.

   CrazyGames lists the game by iframing https://nightraze.io/embed rather than
   hosting a copy of the bundle, which means the browser's framing policy is the
   only thing standing between "listed on a portal" and "reskinned on somebody's
   ad farm". So /embed names its embedders and every other document refuses to
   be framed at all.

   frame-ancestors and not X-Frame-Options: the latter has no wildcard form, so
   it cannot express this list, and where a browser honours both the older
   header wins. Setting it would quietly undo everything below.

   CrazyGames serves the same catalogue from a few dozen regional domains and
   frames the game from whichever one the player arrived on. CSP host sources
   have no wildcard-TLD syntax — the `crazygames.*` shorthand their docs use is
   not a thing a browser will parse — so the suffixes are enumerated. Both the
   apex and the wildcard are listed for each: `*.crazygames.fr` does not match
   `crazygames.fr`, and their canonical hosts are www but their apexes exist. */

/** Public suffixes CrazyGames serves its regional catalogues from. */
const CRAZYGAMES_SUFFIXES = [
  "com",     // www., de., it., vn., gr., ar., th., tr., games., developer.
  "fr",
  "co.id",
  "cz",
  "dk",
  "hu",
  "nl",
  "no",
  "pl",
  "com.br",
  "ro",
  "fi",
  "se",
  "ru",
  "com.ua",
  "at",
  "jp",
  "pt",
  "vn",
  "com.vn",
  "co.kr",
];

/** Partner portals CrazyGames frames the same catalogue from. */
const PARTNER_ORIGINS = ["https://www.1001juegos.com"];

export const CRAZYGAMES_FRAME_ANCESTORS = [
  ...CRAZYGAMES_SUFFIXES.flatMap((suffix) => [
    `https://crazygames.${suffix}`,
    `https://*.crazygames.${suffix}`,
  ]),
  ...PARTNER_ORIGINS,
];

/**
 * frame-ancestors for the embeddable document. EMBED_FRAME_ANCESTORS overrides
 * the list above with a space-separated one, so a new regional domain (or a
 * second portal) is a redeploy rather than a release.
 */
export function embedFrameAncestors(env = process.env): string {
  const override = (env.EMBED_FRAME_ANCESTORS ?? "").trim();
  const sources = override ? override.split(/\s+/) : CRAZYGAMES_FRAME_ANCESTORS;
  return `frame-ancestors ${sources.join(" ")}`;
}

/** frame-ancestors for every other document: nobody. */
export const NO_FRAMING = "frame-ancestors 'none'";
