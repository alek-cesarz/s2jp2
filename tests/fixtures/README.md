# Test fixtures

JP2 test fixtures used by the suite are downloaded on demand from CDSE and
are not checked into git. Run `npm run fetch:fixture` to populate them.
The script requires `~/tools/cdse.json` (a profile for the `get-token`
script). Real-fixture tests skip cleanly when these files are absent.
