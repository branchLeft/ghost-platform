# Bundled themes and fonts

The tenant Ghost image ships a set of open-source Ghost themes and a set of open-licence fonts. Every file is served from the tenant's own origin. This directory holds the pins, the tools that fetch and check them, and the tests. Work item: the curated theme and font set (workspace issue 1650); the decision that fonts are self-hosted is the workspace decision record 1067.

## What is bundled

`manifest.json` is the one record. For each theme it holds the upstream repository, the full commit SHA, the package version, the SPDX licence, the licence file name, its sha256, the copyright line, and a sha256 over the whole theme tree. For each font it holds the same, plus the Reserved Font Name the licence declares (or null) and whether the files are modified (`none`).

Themes (Ghost-authored, MIT): Casper and Source (shipped in the digest-pinned Ghost base image, checked in place), London, Ruby, Edition, Digest, Bulletin, Journal, Headline, Solo, Episode, Starter.

Fonts (SIL OFL 1.1): Inter, Lora, EB Garamond, Mulish, JetBrains Mono, Source Serif 4, IBM Plex Sans, IBM Plex Serif, IBM Plex Mono. Lora, Source Serif 4 and IBM Plex declare a Reserved Font Name, so their files are the upstream bytes, unmodified (no subsetting, no conversion). A modified file under a reserved name would have to be renamed; the manifest refuses an entry that says otherwise.

## What is excluded, and why

A theme is excluded, and listed in `manifest.json` under `excluded` with its reason, when it loads anything from an outside origin at runtime, needs patching, has an unclear or non-open licence, is paid, or is not a theme.

| Theme | Reason |
|---|---|
| Dawn, Ease, Alto, Dope, Edge, Wave | `default.hbs` loads jQuery from code.jquery.com at page load |
| Argon, Lyra, Tribeca | same, and the repositories are archived |
| Taste | loads its fonts from Google Fonts at page load |
| Roon | loads Google Fonts, Pinterest and Twitter scripts and an image from an Amazon S3 bucket; archived |
| Massively, Editorial | archived; the stylesheet imports Google Fonts; the licence file combines MIT with Creative Commons Attribution 3.0 |
| Zap | the repository has no licence file |
| Themes, action-deploy-theme | not themes (a monorepo, and a GitHub Action) |

Paid and marketplace themes are out by licence and are not evaluated one by one.

## How the checks work

`verify.mjs` runs at image build and fails the build on any problem. The same functions run in CI against a synthetic bundle (`verify.test.mjs`), and `image/themes.image.test.mjs` runs against the built image.

- **Pins.** Each theme is fetched as a GitHub tarball at its full commit SHA and its tree hash must equal the manifest's. Each font file must equal its sha256. A font from a release archive (Source Serif 4) checks the archive's sha256 first.
- **Licences.** Each licence file must be present, equal its pinned hash, contain the recorded copyright line, read as the recorded SPDX licence, and be in the open set (MIT, OFL-1.1). A font licence's declared Reserved Font Name must equal the manifest's.
- **Outside origins.** `lib/origins.mjs` reads every `.hbs` file and everything under `assets/` and sorts each absolute URL into a class. A URL in a loading position (script, image, frame, stylesheet link, CSS `url()` or `@import`, form action) is always a failure, and no declaration can allow it. A link target, a feed link or an XML namespace is not a load. Any other URL (a string or comment in JavaScript, say) must be declared in the theme's `externalReferences` with a file, a host, a kind (`navigation`, `comment`, `inert-string`) and a reason. A declaration that matches nothing is a failure. This is a static floor: a URL assembled at runtime is invisible to it.
- **Missing build output.** Every `{{asset "x"}}` a template names must exist in the theme.
- **Rendered pages.** The image test activates each theme in a real Ghost and checks the rendered home page loads nothing from another origin, that its own stylesheets and scripts answer 200, and that the fonts answer with the pinned bytes. Ghost's sample posts point at images on static.ghost.org; those are the fixture's content and are not counted.

## How the fonts are served

The build copies `fonts/` into each theme at `assets/platform-fonts/`, so a font is a file at `/assets/platform-fonts/<family>/<file>.woff2` and the generated stylesheet is `/assets/platform-fonts/fonts.css`. No theme file is changed. Ghost's own font picker (Design settings) writes a Bunny Fonts link into every page when a font is chosen; nothing here selects one, and it must stay on "Theme default" for tenants.

Not done here: nothing yet links `fonts.css` into a tenant's pages. That is a per-site head setting (a site header injection of `<link rel="stylesheet" href="/assets/platform-fonts/fonts.css">`) and belongs with provisioning. Until it is set, the themes use their own font stacks.

## Adding or updating a theme or font

1. Add the entry to `manifest.json` with the full commit SHA and licence file name; leave the hashes out.
2. Run the pin step inside the same Node the image uses, from the repository root, so the tar and Node match the build:
   `docker run --rm -v "$PWD:/work" --entrypoint node <the base image from the Dockerfile> /work/themes/fetch.mjs --out /tmp/out --pin --base-themes /var/lib/ghost/current/content/themes`
3. Build the image (`docker build .`). The Dockerfile step runs `verify.mjs` and fails if the new entry references an outside origin, naming the file and line. Declare only a URL that is a link or a comment, with a reason; otherwise remove the entry and add it to `excluded`.
4. Run the formatter, then `node --test themes/*.test.mjs`.

## Not yet done

- Other open-source Ghost themes that are not Ghost-authored (the ruling asks for a sensible set). None is bundled yet; the exclusions above show the bar a candidate must clear.
- A browser run of each theme (a real browser catches a URL built at runtime, which the static scan cannot).
- Linking `fonts.css` into tenant pages (above).
