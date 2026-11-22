// Theme script: the attacker, as the owner of tenant B, uploads and activates a
// theme of their own with an inline script and a script file in its assets.
// The inline script is the content policy's to refuse. The script file is
// served from the tenant's own origin, so it is only stopped if the platform
// refuses a theme it has not admitted (at upload, at activation, or by never
// serving its files): the case records which layer did, or that none did.

import { victimContext, visit } from '../browser.ts';
import { hostileThemeFiles } from '../payloads.ts';
import type { ThemeObservation } from '../observations.ts';
import { baseThemeFiles, buildZip } from '../themeZip.ts';
import type { World } from '../world.ts';

export async function attackThemeScript(
  world: World,
  themeName: string
): Promise<ThemeObservation> {
  const files = { ...baseThemeFiles(themeName), ...hostileThemeFiles(world.attacker) };
  const upload = await world.b.admin.uploadTheme(`${themeName}.zip`, buildZip(files));
  const activateStatus =
    upload.status >= 200 && upload.status < 300
      ? await world.b.admin.activateTheme(upload.name ?? themeName)
      : null;

  const context = await victimContext(world.browser);
  try {
    const home = await visit(context, `${world.b.origin}/`);
    const file = await visit(context, `${world.b.origin}/assets/js/attack.js`, 200);
    return {
      uploadStatus: upload.status,
      activateStatus,
      vectors: [
        {
          name: 'theme-inline-script',
          ran: home.marks['theme_inline'] === true,
          fileStatus: home.status,
        },
        {
          name: 'theme-script-file',
          ran: home.marks['theme_asset'] === true,
          fileStatus: file.status,
        },
      ],
    };
  } finally {
    await context.close();
  }
}
