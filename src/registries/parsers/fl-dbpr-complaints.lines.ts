import { toText } from '../../text';

/**
 * Reader 2 for the Florida DBPR complaint view. It works on the visible text (toText), one line per
 * block, and never looks at tables or cells. Under the header labels (Number, Class, Incident Date,
 * Status, ...) a complaint is a line of 10 digits, a class line, an incident date and then the status.
 * Cells with no value leave no line, so only the case number and the date two lines below it are
 * relied on. The page ends with the Department's footer line.
 */
const CASE_NUMBER = /^\d{10}$/;
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const HEADER = ['Number', 'Class', 'Incident Date', 'Status'];
const FOOTER = /^The State of Florida is an AA\/EEO employer/i;

/**
 * One entry per complaint, in page order. An empty list when the view lists none. Null when the text is
 * not the complaint view, or ends before its footer, so a cut-off capture is never read as "none".
 */
export function complaintLines(html: string): { case_number: string; status: string }[] | null {
  const lines = toText(html).split('\n');
  if (!lines.includes('Complaint Details')) return null;
  if (!lines.some((line) => /^Below is a listing of public complaints/i.test(line))) return null;
  const header = lines.findIndex((_, i) => HEADER.every((label, k) => lines[i + k] === label));
  if (header === -1) return null;
  const labelsEnd = lines.indexOf('Description', header);
  const footer = lines.findIndex((line, i) => i > header && FOOTER.test(line));
  if (labelsEnd === -1 || footer === -1 || labelsEnd > footer) return null;

  const found: { case_number: string; status: string }[] = [];
  for (let i = labelsEnd + 1; i < footer; i += 1) {
    if (!CASE_NUMBER.test(lines[i]) || !DATE.test(lines[i + 2] ?? '')) continue;
    const status = lines[i + 3] ?? '';
    const isStatus = i + 3 < footer && !DATE.test(status) && !CASE_NUMBER.test(status);
    found.push({ case_number: lines[i], status: isStatus ? status : '' });
  }
  return found;
}
