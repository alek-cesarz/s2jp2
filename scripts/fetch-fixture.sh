#!/usr/bin/env bash
# Downloads two reference Sentinel-2 JP2 assets used by the test suite:
#   1. TCI_10m  - 3-band uint8, 10980x10980, exercises the multi-component RGB path
#   2. B04_60m  - 1-band uint16, 1830x1830, exercises the single-band 16-bit path
# Requires ~/tools/cdse.json (the get-token skill profile) to exist.
set -euo pipefail

ITEM='S2B_MSIL2A_20260502T101019_N0512_R022_T33UWS_20260502T140118'
PROD_ID='6da938c1-db72-4b9a-8f6b-ea8bb7490253'
BASE="https://download.dataspace.copernicus.eu/odata/v1/Products($PROD_ID)/Nodes($ITEM.SAFE)/Nodes(GRANULE)/Nodes(L2A_T33UWS_A047810_20260502T101020)/Nodes(IMG_DATA)"

declare -A ASSETS=(
  ["sample_TCI_10m.jp2"]="$BASE/Nodes(R10m)/Nodes(T33UWS_20260502T101019_TCI_10m.jp2)/\$value"
  ["sample_B04_60m.jp2"]="$BASE/Nodes(R60m)/Nodes(T33UWS_20260502T101019_B04_60m.jp2)/\$value"
)

mkdir -p tests/fixtures
TOKEN=$("$HOME/tools/get_token.sh" "$HOME/tools/cdse.json" | tail -1)
for NAME in "${!ASSETS[@]}"; do
  OUT="tests/fixtures/$NAME"
  if [ -f "$OUT" ]; then
    echo "fixture already present: $OUT"
    continue
  fi
  echo "fetching $NAME ..."
  curl -sL -H "Authorization: Bearer $TOKEN" -o "$OUT" -w "  http=%{http_code} size=%{size_download}\n" "${ASSETS[$NAME]}"
done
