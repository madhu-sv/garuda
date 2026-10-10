// Comments under blog posts (giscus) and the contact page. While a value is empty, that part of the
// site stays hidden.

/**
 * giscus (https://giscus.app): one thread per blog post, stored as a GitHub Discussion in the repo,
 * with replies and reactions. Readers sign in with GitHub. The IDs come from the giscus.app page
 * after Discussions is on and the giscus app is installed on the repo (see docs/release.md).
 */
export const GISCUS = {
  repo: "madhu-sv/garuda",
  repoId: "",
  category: "Blog comments",
  categoryId: "",
};

export function giscusReady(): boolean {
  return GISCUS.repoId !== "" && GISCUS.categoryId !== "";
}

/** The contact page. Empty: not shown. */
export const CONTACT = {
  linkedin: "",
  /** Shown as user [at] domain and joined in the browser, so simple address harvesters miss it. */
  email: "",
  issues: "https://github.com/madhu-sv/garuda/issues",
};
