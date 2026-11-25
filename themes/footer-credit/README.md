# The platform's footer credit in the bundled themes

Every bundled theme prints the platform's default footer credit beside Ghost's own "Powered by Ghost", which stays. `render-core` names the credit for every tenant in `ghost-settings.json` as `footerCredit` (`text`, `url`, `keepGhostCredit: true`; `render-core/src/settings.md`). Ghost has no setting that holds it and a theme cannot read that file, so the image build puts it in the themes.

## What is here

- `platform-footer-credit.hbs`: the partial, one line of markup, `<span class="platform-footer-credit"><a href=URL rel="noopener">TEXT</a></span>`. `TEXT` and `URL` are the placeholders `FOOTER_CREDIT_TEXT` and `PUBLICPRESS_MAIN_SITE_URL`, the same two `render-core` names. The wording and the address are the owner's; when they are supplied they change here and in `render-core` together, and `test_footer_credit.py` fails if they differ.
- `<theme>.patch`: one patch per bundled theme that adds a `{{> platform-footer-credit}}` call inside the element that holds Ghost's credit, right after it. The footers differ, so each theme has its own:
  - `gh-powered-by` themes (London, Ruby, Edition, Digest, Bulletin, Journal): after the "Powered by Ghost" line.
  - Casper: its one-line credit becomes three lines so the call sits inside the same `gh-powered-by` element.
  - Source: inside `gh-footer-copyright`, after the credit.
  - Headline, Solo, Episode: these show Ghost's credit only while no custom footer text is set. The call goes after that condition, so the platform's credit shows either way. A tenant that sets custom footer text still hides Ghost's credit in those three themes, as the theme has always allowed; the platform does not change that.
  - Starter: "Published with Ghost" in `default.hbs` and in `error.hbs`.
- `apply.sh THEMES_DIR`: applies each patch with no fuzz and copies the partial into the theme's `partials/`. It fails when a patch no longer applies, when a patch names a theme that is not there, and when a theme has no patch.

## How it runs

The Dockerfile's themes step runs `apply.sh` on `/var/lib/ghost/content.orig/themes` after `verify.mjs` has checked every pin, so the patches apply to the pinned bytes. Casper and Source are symlinks there into the base image's themes, so they are patched in place. `patch` is installed and removed in the same layer, as for the Ghost-core overlays.

The base image's entrypoint copies a theme into a site's content directory only when that theme is not already there. A site whose content volume already holds an older copy would keep it, so the platform's wrapper entrypoint (`docker-entrypoint.branchleft.sh`, `refresh_bundled_themes`) replaces any bundled theme copy that lacks `partials/platform-footer-credit.hbs` before Ghost starts. It runs on every container start, so a site picks up the credit on its next deploy with no per-tenant step. The replaced copy is moved to `theme-backup-pre-footer-credit/` in the content directory, not deleted.

## Adding or bumping a theme

A new bundled theme needs a patch (`<theme>.patch`, made against the pinned theme tree, paths `a/` and `b/`). A bump that moves the footer lines makes the build fail at `apply.sh`; re-derive that theme's patch. Both are checked by `test_footer_credit.py`, and the built image by `themes/image/themes.image.test.mjs`, which renders every theme's home page and error page and requires a platform credit after each Ghost credit.
