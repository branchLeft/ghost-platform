# mail.ts

## Sending address

The one email address Ghost sends member mail *as* — computed once here and
handed to both `settings.ts` (`members_support_address`, the setting
Ghost's members API actually reads before it sends a magic link) and
`environment.ts` (`mail__from`, the config key that looks like the right one
and is not). The trap this closes: a sender restriction upstream rejects
the two disagreeing as an opaque HTTP 400 on a magic link, with the real
error only in container output. Computing the address exactly once, rather
than in each renderer separately, makes the two disagreeing a compile error
away from possible rather than merely a case a test happens to cover.
