# CSLB fixtures: manifest

Source: Internet Archive (Wayback Machine) captures of the CSLB licence detail page, 2020 to 2023.
Each capture was fetched in its archived form (the `id_` view, without the Wayback toolbar) over https.
Capture URL pattern: `https://web.archive.org/web/<timestamp>id_/<original detail page URL>`.

## Pages

| File | Archive timestamp | Status on page | Discipline flag |
|---|---|---|---|
| wayback-20200809-active.wayback.html | 20200809000831 | active | false |
| wayback-20200829-revoked.wayback.html | 20200829065024 | revoked | true (complaint disclosure) |
| wayback-20211119-suspended.wayback.html | 20211119230757 | suspended | false (advisory only) |
| wayback-20220122-active.wayback.html | 20220122030544 | active | false |
| wayback-20220813-active.wayback.html | 20220813094330 | active | false |
| wayback-20220819-active.wayback.html | 20220819084617 | active | false |
| wayback-20221204-active.wayback.html | 20221204211934 | active | false |
| wayback-20230608-active.wayback.html | 20230608215715 | active | false |
| wayback-20230920-revoked.wayback.html | 20230920044933 | revoked | true (complaint disclosure) |
| wayback-20231029-active.wayback.html | 20231029100050 | active | true (complaint disclosure pointer) |

Each `*.wayback.html` has a sibling `*.wayback.expected.json`, written from a read of the scrubbed page
(the values a person reads). `data_as_of` is the date after "Data current as of" (hidden span).

Hand-written samples (no archive capture): `search.agent.json` (agent output shape for a search) and
`record.agent.json` (agent output shape for a record, matching the 2022-08-19 page).

## Edits made to each captured page

Applied to all ten pages unless a line says otherwise.

1. Licence number: every whole-number occurrence replaced by a fake, `0000001` to `0000009`
   (one licence number is shared by two captures, so it maps to the same fake in both).
   The fake form is a run of zeros, so the fixture scrub test accepts it.
2. Business phone number: the "Business Phone Number:" label and its number removed.
3. Bond numbers and policy numbers: replaced by `0000000`.
4. Personnel name on the "qualifying individual ... certified" line: replaced by `SAMPLE, PERSON A`
   (on the pages that carry such a line: 20200809, 20211119, 20220122, 20220813, 20220819, 20221204).
5. Business street line: replaced by `1 Sample St`. Business city line: replaced by `SAMPLE CITY, CA 00000`.
   Business names are kept as shown.
6. LicenseDetail form action: the whole action value replaced by `/OnlineServices/CheckLicenseII/LicenseDetail.aspx`
   (removes an archived e-mail address and tracking tokens that the action carried on some captures).
7. The Microsoft sign-in link in the footer list: its href replaced by `#` (it carried tenant and request identifiers).

Nothing else on the page was changed. Dates, statuses, classifications, and disclosure text are as archived.

## Expected-value files

`*.expected.json` files were written from the scrubbed pages. The licence number in each expected file is the fake.
The expected values are the reading a person takes from the page, not parser output.
