# Registry page fixtures

- `mqa-a.html` and `dbpr-a.html` are real registry pages (Florida MQA and DBPR), saved 2026-11-04. Every licence number, internal record id, street address, city, ZIP, county, phone number and person name is replaced with a fake value (`SAMPLE, PERSON A`, `1 Sample St`, `SAMPLE CITY, FL 00000`, `ME000000`, `CCC0000000`). Everything else is kept as saved.
- `mqa-a-dataasof.edited.html` and `mqa-a-status.edited.html` are copies of `mqa-a.html` that change one field each. They are test data only, not registry pages.
- `tests/agree.test.ts` holds hand-built `Fields` that mirror `mqa-a.html` and its two edited copies.
