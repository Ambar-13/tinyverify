# Florida DBPR fixtures: manifest

Every page here is either a live record page saved on 2026-11-04 or a Wayback capture of a DBPR licence page (LicenseDetail.asp). Expected values sit beside each page as `<same name>.expected.json`. The samples `search.agent.json` and `record.agent.json` are hand-written to the agent schemas, not captures.

## Common edits (every page)

- Primary licensee name: replaced with a sample name (SAMPLE, PERSON plus a letter), in the page body and in the meta description.
- Licence number: replaced with a fake number that keeps the page's own prefix.
- Main Address and License Mailing blocks: street, city, state and ZIP replaced with the sample address.
- County cells: every county value replaced with the word Sample. Out-of-state wording is kept where the page gives it.
- Meta description Location clause: replaced with the sample address.
- Record ids (the licid value in links and the hidden ID input): replaced with 0.
- DBPR headquarters address, in the footer and the map links: replaced with the sample address. Map coordinates replaced with zeros.
- DBPR agency phone number, both printed forms: replaced with a fake number.
- Business (DBA) names: replaced by a placeholder (SAMPLE ONE ROOFING LLC, SAMPLE TWO LLC) in the older pages and expected files, as in the `tf/` pages. `tests/fixtures.test.ts` fails if a replaced name returns, from hashes only.
- No other text is changed.

## Pages

| File | Archive timestamp | Source | Licence type | Status (raw) | Edits beyond common |
|---|---|---|---|---|---|
| `live-contractor-1.fetch.html` | none (live) | DBPR record page saved 2026-11-04 | Certified Roofing Contractor | Current,Active | Primary name replaced with the sample name for person A; street, city and ZIP lines replaced with the sample address; county replaced with Sample; licence number and record id replaced with fakes; agency phone and headquarters as above. Dates and rank kept. |
| `wayback-20210616-certified.wayback.html` | 20210616195848 | `LicenseDetail.asp?SID=&id=` capture | Certified Residential Contractor | Current,Active | Common edits only. |
| `wayback-20210622-certified.wayback.html` | 20210622193406 | as above | Certified Pool/Spa Contractor | Current,Active | Common edits only. |
| `wayback-20211201-certified.wayback.html` | 20211201210454 | as above | Certified Roofing Contractor | Current,Active | License Location block (street, city and ZIP) replaced with the sample address. |
| `wayback-20220127-certified.wayback.html` | 20220127025723 | as above | Certified Alarm System Contractor II | Current,Active | License Location block replaced with the sample address. |
| `wayback-20220930-certified.wayback.html` | 20220930102828 | as above | Certified Building Contractor | Current,Active | License Location block replaced with the sample address. |
| `wayback-20230401-certified.wayback.html` | 20230401234604 | as above | Certified Electrical Contractor | Delinquent,Active | Out-of-state licensee: address replaced with the sample address using the non-Florida state code TX. County wording kept. |
| `wayback-20230924-certified.wayback.html` | 20230924134217 | as above | Certified Building Contractor | Current,Active | Common edits only. |
| `wayback-20240617-certified.wayback.html` | 20240617071054 | as above | Certified General Contractor | Current,Active | License Location block replaced with the sample address. |
| `wayback-20240730-registered.wayback.html` | 20240730114936 | as above | Registered Specialty Contractor | Delinquent,Active | Registered licence (RX prefix). License Location block replaced with the sample address. |
| `wayback-20240917-certified.wayback.html` | 20240917222800 | as above | Certified Roofing Contractor | Current,Active | License Location block replaced with the sample address. |

Each `wayback-*.wayback.html` was taken with the `id_` form of the Wayback URL (`http://web.archive.org/web/<timestamp>id_/<original>`), which returns the page without the Wayback toolbar.

## Other samples

- `search.agent.json`: three hand-written rows to the search schema. Its link ids are placeholders of 31 zeros plus a final digit.
- `record.agent.json`: one hand-written record to the record shape, matching the live expected values.

## Notes on the scrub

- The 2023-04 out-of-state page keeps its non-Florida state code (TX) beside the sample address.
- The License Location block is replaced on six pages. The label is spelled with a space on the older pages and without one on the newer pages, and both spellings are matched. Each page's font wrapper is kept.
- A scan of every DBPR fixture finds only the sample street, and no Florida state code followed by a non-sample ZIP.

## Fetch-form pages (`tf/`)

TinyFish Fetch (`format: html`) returns extracted content for the record page, not the page's own HTML:
no field labels, one `<p>` per value. Captured on 2026-11-09 with `scripts/capture.ts` and scrubbed by
`scripts/capture.ts --scrub` (primary name, street, city line and county replaced; licence-number digits
become zeros with the prefix kept; the business name line replaced with a placeholder such as SAMPLE ROOFING LLC, because a business name next to a licence type and real dates names the person behind a one-person company). Read by
`tests/fetch-form.test.ts`.

| File | Source | Kind |
|---|---|---|
| `tf/contractor-cbc.tf.html` | live record, Certified Building Contractor, Current,Active | captured |
| `tf/contractor-ccc.tf.html` | live record, Certified Roofing Contractor, Current,Active, with the address block repeated | captured |
| `tf/contractor-null-void.tf.html` | live record, Certified Electrical Contractor, status Null and Void, out-of-state licensee | captured |
| `tf/derived-five-fields.tf.html` | `tf/contractor-cbc.tf.html` with the expiry `<p>` removed (5 values in the second section) | derived |
| `tf/derived-suspended.tf.html` | `tf/contractor-cbc.tf.html` with the status changed to `Suspended,Inactive` | derived |
| `tf/derived-dates-swapped.tf.html` | `tf/contractor-cbc.tf.html` with the licensure and expiry dates swapped | derived |
| `tf/derived-out-of-state.tf.html` | `tf/contractor-null-void.tf.html` with the city line changed to `SAMPLE CITY North Carolina 00000` | derived |

## Complaint view (`complaints/`)

The page "View License Complaint" opens, read by `complaintRows` and, from its text lines, by `complaintLines`. Read by `tests/fl-dbpr.test.ts`, `tests/check.test.ts` and `tests/watch.test.ts`.

What the two captures show: a licence with complaints has the licensee's name under the Name label and one `tbody` row of 7 `td` cells for each complaint, under a `thead` of 7 `th` cells; the last cell holds one `div` for each discipline line. The clean capture is a business licence whose Name line is empty on every capture, also on one taken after waiting until the page stopped changing, so an empty Name line is not a sign of an unfinished page. The page header holds a clock that changes every second. Both captures end with the same footer, which is the sign `complaintRows` asks for; `complaintLines` asks for the footer's first sentence. Neither capture shows the licence number or the record id anywhere (no link, form field or text), so the page cannot be tied to its licence and the readers return no tie. The tests derive their variants in code (a first cell that is not a case number, a capture cut before the footer); no derived file is kept.

| File | Source | Kind |
|---|---|---|
| `complaints/complaint-view.clean.html` | agent run snapshot of the complaint view of a contractor with no complaints, 2026-11-09: a header row and no complaint rows. The licensee's name is not in the snapshot. The Department's footer address and phone numbers replaced (`scripts/capture.ts --scrub`, kind `fl-dbpr-complaints`) | captured |
| `complaints/complaint-view.real-three-rows.html` | agent run snapshot of the complaint view of a contractor with 3 public complaints, 2026-11-09, taken after the goal's wait-until-stable step. The licensee's name line, the 3 case numbers (first cell of each row), the Department's footer address and phone numbers replaced (`scripts/capture.ts --scrub`, kind `fl-dbpr-complaints`); incident dates, statuses, dispositions and discipline lines are the real ones | captured |

## Results list (`results/`)

The page a search opens on the contractor board, read by `rowsFromSnapshot`. Read by `tests/fl-dbpr.test.ts`. Both files are reduced captures: the page's title, its "Search Results - N Records" heading and the results form are kept, and the navigation, footer and map are cut. The layout is the same for a licence-number search and a name search, so there is one fixture for each. The table has a header row of five cells (License Type, Name, Name Type, License Number/ Rank, Status/Expires), one row of five cells for each name line of a licence, and under each such row an address row. The name cell holds the link, written relative (`LicenseDetail.asp?SID=&id=<32 hex>`); the total is the hidden `hTotalRecords` value. Scrubbed by `scripts/capture.ts --scrub`, kind `fl-dbpr-results`: every name replaced (a Primary line by `SAMPLE, PERSON <letter>`, any other line by `SAMPLE BUSINESS <n>, INC.`), link ids replaced by 31 zeros and a digit, licence numbers by the prefix and a short number of zeros, address lines by the sample street and city, and the typed search values echoed as hidden inputs by sample values.

| File | Source | Kind |
|---|---|---|
| `results/results-number.snapshot.html` | run snapshot (step 5) of a licence-number search of the golden licence, 2026-11-09: 2 rows for one licence, a DBA line and a Primary line | captured, reduced |
| `results/results-name.snapshot.html` | run snapshot (step 5) of a business-name search, 2026-11-09: 4 rows, 4 licences | captured, reduced |
