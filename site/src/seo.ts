// Search and share settings of the site (landing page, blog and docs).

/**
 * Google Search Console: the `content` value of its "HTML tag" verification method, for the URL
 * prefix property https://madhu-sv.github.io/garuda/. Empty: no tag. The value is public by design
 * (it is in every page).
 */
export const GOOGLE_SITE_VERIFICATION = "0xFTn4V1Y_azNh21AfC60Spsx_gJ72F4TKB0pCdqCHQ";

/** The share image for LinkedIn, X and chat previews: 1200×630, in site/public. */
export const SHARE_IMAGE = {
  path: "og.png",
  width: 1200,
  height: 630,
  alt: "Garuda: the open-source coding agent that asks first. OS sandbox, approvals, audit log.",
};

/** Absolute URL of the share image. `site` is "https://madhu-sv.github.io", `base` "/garuda". */
export function shareImageUrl(site: string, base: string): string {
  return `${site.replace(/\/$/, "")}${base.replace(/\/?$/, "/")}${SHARE_IMAGE.path}`;
}
