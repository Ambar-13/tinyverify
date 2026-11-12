# Fixture manifest (Florida MQA)

Every file here is either a saved registry page with identifiers replaced, an
expected-values file, or a hand-written sample. Fake values: names `SAMPLE, PERSON A`
(and `SAMPLE, PERSON B` / `SAMPLE PHARMACY` in related-party rows), street `1 Sample St`,
city `SAMPLE CITY, FL 00000`, licence numbers in the form `<PREFIX>000000` onward, and
internal ids `LicInd=0&ProCde=0`.

## Saved pages (scrubbed)

- `live-physician-1.fetch.html`: browser save of a physician record, 2026-11-04. Name, street,
  city, licence number and internal ids replaced.
- `wayback-<yyyymmdd>-<profession>.wayback.html`: Wayback Machine captures (`id_` flag, original
  page), the timestamp in the file name is the snapshot date. Each one had name, address lines,
  city, licence number and internal ids replaced; related-party table rows (a subordinate
  physician and a pharmacy) replaced; the Department of Health phone number removed.
  - `wayback-20230324-physician`: snapshot 20230324220150.
  - `wayback-20230807-physician`: snapshot 20230807143946. Related-party row replaced.
  - `wayback-20231028-nurse`: snapshot 20231028134524.
  - `wayback-20240229-pharmacist`: snapshot 20240229174851. Related-party row replaced.
  - `wayback-20240302-physician`: snapshot 20240302002834.
  - `wayback-20240917-nurse`: snapshot 20240917163053.
  - `wayback-20250121-nurse`: snapshot 20250121110111.
  - `wayback-20250228-physician`: snapshot 20250228160422.
  - `wayback-20250325-dentist`: snapshot 20250325181918.
  - `wayback-20250807-paramedic`: snapshot 20250807063608.
  - `wayback-20251201-emt`: snapshot 20251201145448.
- `tabs/enforcement-tab.fetch.html`: the live discipline tab (`LoadEnforcementActionsTab`), fetched
  2026-11-04 with the internal ids of the registrant in `wayback-20230324-physician`. Name, licence
  digits, city, case numbers, document ids (base64), the Department of Health address and phone
  number replaced. Edited: the "No Emergency Actions Found" paragraph was replaced by an emergency
  actions table with one invented row (case 000103, Emergency Restriction Order, 8/14/2023), so
  that all three sections of the tab are exercised.

## Expected values and samples

- `*.expected.json`: values read off each page before scrubbing, with the fake identifiers.
  The discipline rule: Public Complaint Yes or an enforcement alert sets `discipline_flag` true and
  lists every "Enforcement Alert" line and every "Emergency ... Order" line in `discipline_actions`,
  in page order. Two files show it:
  - `wayback-20231028-nurse.wayback.expected.json`: flag true; actions
    `["Enforcement Alert", "Emergency Restriction Order filed 08/14/2023."]`.
  - `wayback-20250807-paramedic.wayback.expected.json`: flag true; actions
    `["ENFORCEMENT ALERT", "Emergency Suspension Order filed 07/17/2025."]`.
- `search.agent.json`: hand-written to the search output schema. Not an agent transcript.

## Fetch-form pages (`tf/` and `tabs/`)

TinyFish Fetch (`format: html`) does not return the registry's own HTML; it returns extracted content,
with `<strong>` labels and `<dd>` values on the record page and no headings on the enforcement tab.
Captured on 2026-11-09 with `scripts/capture.ts`, then scrubbed by `scripts/capture.ts --scrub`
(name, street, city and licence number replaced; the licence-number digits become zeros, the licence
prefix is kept). Read by `tests/fetch-form.test.ts`.

| File | Source | Kind |
|---|---|---|
| `tf/physician-active.tf.html` | live record, a physician, status Clear/Active | captured |
| `tf/nurse-active.tf.html` | live record, a registered nurse, status Clear/Active | captured |
| `tf/nurse-disciplined.tf.html` | live record, a licensed practical nurse, status DELINQUENT/, Discipline on File and Public Complaint Yes | captured |
| `tf/derived-not-active.tf.html` | `tf/physician-active.tf.html` with the status changed to `Retired` | derived |
| `tabs/enforcement-tab.disciplined.tf.html` | live `LoadEnforcementActionsTab` of the disciplined nurse above: no headings, an empty-emergency sentence, then a discipline table and a public-complaint table. Names, licence, city and case numbers replaced; Department address and phone replaced | captured |
| `tabs/enforcement-tab.clean.tf.html` | live `LoadEnforcementActionsTab` of a practitioner with nothing on file, 2026-11-09 (the second health-board golden record returned the identical page): no headings, three sentences "No Emergency Actions Found", "No Discipline Found", "No Public Complaint Found", then the public-records notice. Department address and phone replaced | captured |

## Results-page snapshot (`snapshots/`)

| File | Source | Kind |
|---|---|---|
| `snapshots/results-page.snapshot.html` | page snapshot of step 10 of a real name-search run (TinyFish `/v1/runs/{run}/steps/{step}/html`, 2026-11-09): the first results page, 20 rows, "Search Results Total: 91" | captured |

Scrubbed by hand-written rules: the 20 names became `SAMPLE, PERSON A` to `T`, the cities `SAMPLE CITY`, the
licence numbers `ME000001` to `ME000020`, and the `LicInd` of each row's link the row number 1 to 20 (the
`ProCde`, profession and status wording are the registry's own and kept; the profession cell is cut short by the
page itself). The search terms inside the CSV export link (`jsonModel`) became `PERSON` and `SAMPLE`. It sits in a
sub-folder so the record-page pairing check in `fl-mqa.test.ts` does not take it for a record page. Read by the
`rowsFromSnapshot` tests.
