# runtime.ts

## Runtime bounds

The numbers that bound one tenant's Ghost container on a shared host,
derived from one input rather than set separately.

The uid range and the resource-cap fields already live in `brand.ts` and
`descriptor.ts` — validated there, on the descriptor itself — so this module
keeps only the one thing that is not a descriptor field: the upload-ceiling
derivation, sized identically for every kind because no descriptor field
carries a tenant-specific ceiling to derive from instead.
