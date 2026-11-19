# Bundled themes and fonts

The tenant Ghost image ships a set of open-source Ghost themes and a set of open-licence fonts. Every file is served from the tenant's own origin. This directory holds the pins, the tools that fetch and check them, and the tests. The rule behind all of it: the platform serves everything from the tenant's own origin and its content policy has no font rule, so a theme or font that loads anything from another origin either breaks or leaks a reader's request. Fonts are therefore self-hosted.

## What is bundled

`manifest.json` is the one record. For each theme it holds the upstream repository, the full commit SHA, the package version, the SPDX licence, the licence file name, its sha256, the copyright line, and a sha256 over the whole theme tree. For each font it holds the same, plus the Reserved Font Name the licence declares (or null) and whether the files are modified (`none`).

Themes (Ghost-authored, MIT): Casper and Source (shipped in the digest-pinned Ghost base image, checked in place), London, Ruby, Edition, Digest, Bulletin, Journal, Headline, Solo, Episode, Starter.

Fonts (SIL OFL 1.1): Inter, Lora, EB Garamond, Mulish, JetBrains Mono, Source Serif 4, IBM Plex Sans, IBM Plex Serif, IBM Plex Mono, Space Grotesk. Lora, Source Serif 4 and IBM Plex declare a Reserved Font Name, so their files are the upstream bytes, unmodified (no subsetting, no conversion). A modified file under a reserved name would have to be renamed; the manifest refuses an entry that says otherwise.

## What is excluded, and why

A theme is excluded, and listed in `manifest.json` under `excluded` with its reason, when it loads anything from an outside origin at runtime, needs patching, has an unclear or non-open licence, is paid, or is not a theme.

| Theme | Reason |
|---|---|
| Dawn, Ease, Alto, Dope, Edge, Wave | `default.hbs` loads jQuery from code.jquery.com at page load |
| Pico, Wave-Archive | same (`default.hbs` line 90 in Pico loads jQuery 3.4.1; Wave-Archive loads 3.3.1); MIT, archived |
| Argon, Lyra, Tribeca | same, and the repositories are archived |
| Source-ActivityPub, Starter-ActivityPub | customised copies of Source built for one site, not general-purpose themes (reason `site-specific`) |
| Taste | loads its fonts from Google Fonts at page load |
| Roon | loads Google Fonts, Pinterest and Twitter scripts and an image from an Amazon S3 bucket; archived |
| Massively, Editorial | archived; the stylesheet imports Google Fonts; the licence file combines MIT with Creative Commons Attribution 3.0 |
| Zap | the repository has no licence file |
| Themes, action-deploy-theme | not themes (a monorepo, and a GitHub Action) |

Paid and marketplace themes are out by licence and are not evaluated one by one.

### No theme goes unscreened

`org-theme-repos.snapshot.json` is a committed snapshot of the TryGhost organisation's open-source theme repositories. `manifest.test.mjs` requires that the bundled themes together with `excluded` equal the snapshot exactly, so a repository that appears in the snapshot without a decision (or an entry for a repository not in it) turns the test red.

To refresh the snapshot, list the organisation and update `repos` and `takenOn`:

1. `gh repo list TryGhost --limit 1000 --topic ghost-theme --json name --jq '.[].name'` gives every repository with the `ghost-theme` topic.
2. Some theme repositories carry no topic (Wave-Archive and the two ActivityPub copies did not). Read the rest of the organisation for them: `gh repo list TryGhost --limit 1000 --json name,description,isArchived --jq '.[] | select((.description // "") | test("theme"; "i")) | [.name, .isArchived, .description] | @tsv'`, and add each real Ghost theme.
3. Add a decision for every new name: bundle it (below) or add it to `excluded` here and in `manifest.json` with its reason, then run `node --test themes/*.test.mjs`.

## Fonts the themes carry themselves

Ten themes carry their own font files under `assets/fonts/`, Source (from the base image) among them (Lora, PT Serif, Raleway, Open Sans, Libre Baskerville, Mona Sans, Manrope, Mulish, Inter, JetBrains Mono, EB Garamond). The theme's own MIT licence does not cover them. They are kept exactly as the theme ships them (no subsetting, no conversion, no renaming) and the manifest records them:

- `embeddedFontFamilies` has one record per family: the SIL OFL 1.1 text (`licences/<family>/OFL.txt`, fetched with `curl` from the font's upstream repository at the pinned commit, named in `licence.sourcePath`, never typed by hand), its copyright line, its sha256, and the Reserved Font Names the licence declares (`reservedFontNames`, empty when none).
- Each theme's `embeddedFonts` lists every font file by path and sha256. `verify.mjs` fails a font file (any `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot` or `.ttc`, anywhere in a theme, base-image themes included) that the manifest does not list, a listed file that is missing, and a file whose bytes differ from the pin. For a family with a Reserved Font Name the failure says so: a modified file may not ship under that name.
- The build ships each family's licence text beside the platform fonts, at `/assets/platform-fonts/embedded/<family>/OFL.txt` in every theme.
- A pinned hash proves the bytes are the ones the theme commits, which are web builds of the fonts, not necessarily the foundry's own release files (no file here has been shown byte-identical to a foundry release). Reserved-name families are Lora, PT Serif, Raleway, Libre Baskerville and Mona Sans.

To add a font family, fetch its licence with `curl -fsSL -o themes/licences/<family>/OFL.txt <raw URL at a full commit>`, add the family and the file lists to the manifest, and run `fetch.mjs --pin`.

## How the checks work

`verify.mjs` runs at image build and fails the build on any problem. The same functions run in CI against a synthetic bundle (`verify.test.mjs`), and `image/themes.image.test.mjs` runs against the built image.

- **Pins.** Each theme is fetched as a GitHub tarball at its full commit SHA and its tree hash must equal the manifest's. Each font file must equal its sha256. A font from a release archive (Source Serif 4) checks the archive's sha256 first.
- **Licences.** Each licence file must be present, equal its pinned hash, contain the recorded copyright line, read as the recorded SPDX licence, and be in the open set (MIT, OFL-1.1). A font licence's declared Reserved Font Name must equal the manifest's.
- **Usage.** `node themes/fetch.mjs --out DIR` fetches, checks every pin and writes `DIR/themes` and `DIR/fonts`; with `--pin` it is the maintainer step that computes and writes the pins. `node themes/verify.mjs --bundle DIR [--base-themes DIR]` checks that output; `--base-themes` is the themes directory of the Ghost base image, where Casper and Source ship.
- **Outside origins.** `lib/origins.mjs` reads every `.hbs` file and everything under `assets/` and sorts each absolute URL into one of four classes: `namespace` (an XML or RSS identifier, never fetched), `navigation` (an `<a href>` or a `<link rel="alternate|canonical|...">` target that a click or feed reader follows), `load` (a URL a browser fetches without a click) and `other`. A URL in a loading position (script, image, frame, stylesheet link, CSS `url()` or `@import`, form action) is always a failure, and no declaration can allow it. A link target, a feed link or an XML namespace is not a load. Any other URL (a string or comment in JavaScript, say) must be declared in the theme's `externalReferences` with a file, a host, a kind (`navigation`, `comment`, `inert-string`) and a reason. A declaration that matches nothing is a failure. This is a static floor: a URL assembled at runtime is invisible to it.
- **Missing build output.** Every `{{asset "x"}}` a template names must exist in the theme.
- **Rendered pages.** The image test activates each theme in a real Ghost and checks the rendered home page loads nothing from another origin, that its own stylesheets and scripts answer 200, and that the fonts answer with the pinned bytes. Ghost's sample posts point at images on static.ghost.org; those are the fixture's content and are not counted.

## How the fonts are served

The build copies `fonts/` into each theme at `assets/platform-fonts/`, so a font is a file at `/assets/platform-fonts/<family>/<file>.woff2` and the generated stylesheet is `/assets/platform-fonts/fonts.css`. Ghost's own font picker (Design settings) writes a Bunny Fonts link into every page when a font is chosen; the platform clears it on every apply (`render-core/src/settings.md`), and the tenant font choice below replaces it.

## How a tenant chooses a font

Head code injection is blocked, so no site setting can link `fonts.css`. The theme does it instead. After the pins are verified, the image build gives every bundled theme (`fetch.mjs --platform-fonts`, run by the Dockerfile on each theme and failing the build on any):

- two theme settings in `package.json` (`config.custom`): `platform_heading_font` and `platform_body_font`, each a select of `Theme default` and every family in `manifest.json`. They show in Ghost admin under Design, Customize, the theme's own settings. `Theme default` is the default, and nothing changes until a family is chosen;
- `partials/platform-fonts.hbs`, generated from the manifest, and one `{{> "platform-fonts"}}` after `{{ghost_head}}` in `default.hbs`. A chosen family links the theme's own `fonts.css`, sets `--gh-font-heading` or `--gh-font-body` (the variables every bundled theme's stylesheet already reads, and the ones Ghost's picker set) and gives `h1`-`h6` or `body` that font, so a theme that never read the variable follows too. The page names only its own origin, and the content policy needs no change (`style-src` already allows the inline rule, `font-src` falls back to `'self'`).

To get Space Grotesk headings, a tenant sets Heading font to Space Grotesk in Ghost admin and saves. Both fonts are chosen independently, and a font file is fetched only by a page that uses it.

Source ships nineteen settings of its own and Ghost allows twenty, so for a theme with no room the build extends the theme's own `title_font` and `body_font` selects with the families instead (a theme with neither fails the build). In Source the heading choice is then "Title font" and the body choice "Body font". Source's own typography partial treats a title font that is neither Modern sans-serif nor Elegant serif as its mono option, so a chosen family also keeps Source's own mono font preloaded.

The choice is Ghost data, not tenant-template data. A platform-applied default for a tenant (writing `custom_theme_settings` through the Admin API from the tenant descriptor) is not built: the reconciler writes Ghost settings only, and a theme setting exists only once its theme is active.

To offer another family, add it to `manifest.json` (below) with a `fallback` of `sans-serif`, `serif` or `monospace`; the settings, the partial and the checks follow from the manifest.

## Adding or updating a theme or font

1. Add the entry to `manifest.json` with the full commit SHA and licence file name; leave the hashes out.
2. Run the pin step inside the same Node the image uses, from the repository root, so the tar and Node match the build:
   `docker run --rm -v "$PWD:/work" --entrypoint node <the base image from the Dockerfile> /work/themes/fetch.mjs --out /tmp/out --pin --base-themes /var/lib/ghost/current/content/themes`
3. Build the image (`docker build .`). The Dockerfile step runs `verify.mjs` and fails if the new entry references an outside origin, naming the file and line. Declare only a URL that is a link or a comment, with a reason; otherwise remove the entry and add it to `excluded`.
4. Run the formatter, then `node --test themes/*.test.mjs`.

## Not yet done

- Other open-source Ghost themes that are not Ghost-authored (the ruling asks for a sensible set). None is bundled yet; the exclusions above show the bar a candidate must clear.
- A browser run of each theme (a real browser catches a URL built at runtime, which the static scan cannot).
