// The Garuda website: a landing page and a blog (Astro pages), and the docs (Starlight) under /docs.
// GitHub Pages serves it at https://madhu-sv.github.io/garuda/.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { GOOGLE_SITE_VERIFICATION, SHARE_IMAGE, shareImageUrl } from "./src/seo.ts";

const site = "https://madhu-sv.github.io";
const base = "/garuda";
const shareImage = shareImageUrl(site, base);

export default defineConfig({
  site,
  base,
  trailingSlash: "always",
  // Code in blog posts: one dark theme, like the terminal blocks of the landing page.
  markdown: { shikiConfig: { theme: "github-dark" } },
  integrations: [
    starlight({
      title: "Garuda",
      description:
        "A terminal coding agent with an OS sandbox, a permission engine, a team policy and an audit log.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      // Starlight sets the other share tags (title, description, twitter:card); the image and the
      // Search Console tag come from src/seo.ts, as on the landing page.
      head: [
        { tag: "meta", attrs: { property: "og:image", content: shareImage } },
        { tag: "meta", attrs: { property: "og:image:width", content: String(SHARE_IMAGE.width) } },
        {
          tag: "meta",
          attrs: { property: "og:image:height", content: String(SHARE_IMAGE.height) },
        },
        { tag: "meta", attrs: { property: "og:image:alt", content: SHARE_IMAGE.alt } },
        { tag: "meta", attrs: { name: "twitter:image", content: shareImage } },
        ...(GOOGLE_SITE_VERIFICATION === ""
          ? []
          : [
              {
                tag: "meta",
                attrs: { name: "google-site-verification", content: GOOGLE_SITE_VERIFICATION },
              },
            ]),
      ],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/madhu-sv/garuda" }],
      editLink: { baseUrl: "https://github.com/madhu-sv/garuda/edit/main/site/" },
      lastUpdated: false,
      components: { MarkdownContent: "./src/components/MarkdownContent.astro" },
      customCss: [
        "@fontsource-variable/inter",
        "@fontsource-variable/newsreader",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/starlight.css",
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Introduction", slug: "docs" },
            { label: "Install", slug: "docs/install" },
            { label: "Quick start", slug: "docs/quick-start" },
            { label: "Editors", slug: "docs/editors" },
            { label: "Security model", slug: "docs/security" },
          ],
        },
        { label: "User guide", slug: "docs/guide" },
        {
          label: "Design",
          items: [
            { label: "Overview", slug: "docs/design" },
            { label: "Architecture", slug: "docs/design/architecture" },
            { label: "High-level design", slug: "docs/design/hld" },
            {
              label: "Components",
              collapsed: true,
              items: [{ autogenerate: { directory: "docs/design/lld" } }],
            },
            {
              label: "Quality",
              collapsed: true,
              items: [{ autogenerate: { directory: "docs/design/quality" } }],
            },
          ],
        },
        { label: "Blog", link: "/blog/" },
      ],
    }),
  ],
});
