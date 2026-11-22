# verdictSourceReport.ts

## What it answers

Whether a slot's rendered configuration names a production verdict source.
`/status` reports it as `productionVerdictSource`, next to the stand-in lists,
and the demo's go-live step (`demo-host/provision/demo_go_live.py`) refuses
while it is anything but `true`.

It is read from the `compose.yml` render-core wrote into the slot's directory
(`slotNamesProductionVerdictSource`), so it can only say what was rendered. No
caller can set it and no environment variable reaches it.

## Fails closed

`true` needs a `storage__<feature>__verdictSource` line for each of `images`,
`media` and `files`, and every such line (a compose file carries one set per
colour) must be exactly `production`, the one value the scanning adapter
treats as real (`adapters/scanning-storage/src/verdict-source.md`). A slot that
was never rendered, a file that cannot be read, a missing key, the in-process
fake, any other value and an empty file are all `false`.

Today render-core renders no `verdictSource` for a demo, on purpose
(`render-core/src/environment.md#verdict-source`), so every slot reads
`false` and the demo keeps refusing uploads until the production render lands.

## Sabotage

`test/unit/verdictSourceReport.test.ts` and `test/unit/app.test.ts` go red when
`handleStatus` drops the field or the reader always answers `true`.
