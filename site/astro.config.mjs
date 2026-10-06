// The Garuda website: a landing page and a blog (Astro pages), and the docs (Starlight) under /docs.
// GitHub Pages serves it at https://madhu-sv.github.io/garuda/.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://madhu-sv.github.io",
  base: "/garuda",
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
