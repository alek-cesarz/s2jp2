# s2jp2

TypeScript library for streaming Sentinel-2 JPEG 2000 tiles: marker parsers
(SIZ/TLM/COD/PLT), window-to-tile-range planning, and a WASM decoder
(OpenJPEG 2.5.3) supporting `cp_reduce` + windowed decode.

## Status
Pre-release. Scope: any Sentinel-2 MSI JP2 asset on the S2 N0512 framework
(TCI / reflectance bands / SCL / CLD / SNW / AOT / WVP at 10 m, 20 m, or 60 m).

## Install
```bash
npm install s2jp2
```

## Use
See `tests/pipeline.test.ts` for a full end-to-end example.

## Develop
```bash
npm install
npm run fetch:fixture   # downloads two test JP2s via CDSE token (TCI 10m + B04 60m)
npm test
```
