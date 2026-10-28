# refusal-error.js

## Refusal wording

The wording splits by classification: generic for `csam`, specific for
everything else.

For `csam`, the specific reason is operational intelligence handed to
whoever is holding the account, which may not be the tenant, so the message
stays generic (`GENERIC_CONTEXT`).

For every other classification, the message names it. An upload is always
made by authenticated staff, who get an accurate answer rather than being
treated as adversaries.

## Video and audio refusal

`buildVideoAudioRefusedError` is a typed `UnsupportedMediaTypeError`
(415) for video or audio on a tier that does not accept them. Nothing was
hashed or checked, so it names no classification. Its message and context
are the placeholders `VIDEO_AUDIO_REFUSED_MESSAGE` and
`VIDEO_AUDIO_REFUSED_CONTEXT`; the owner supplies the real wording.
