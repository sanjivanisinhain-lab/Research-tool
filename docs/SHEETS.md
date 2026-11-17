# Keeping a Google Sheet in step with the tool

The tool can read a Google Sheet of call notes every few minutes. New rows are added, edited rows are read again, removed rows are flagged. Anyone can then open the exact row an insight came from.

## One-time setup (about 10 minutes, needs access to Google Cloud)

1. In Google Cloud, create a project (or use one your company has) and turn on the **Google Sheets API**.
2. Create a **service account** (IAM and admin, Service accounts). Open it, then Keys, Add key, JSON. A file downloads. It is a password: keep it out of chat, email and git.
3. Start the server with the key available:
   - `GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json`, or
   - `GOOGLE_SERVICE_ACCOUNT_JSON` containing the file's contents.
4. The server must be able to reach `oauth2.googleapis.com` and `sheets.googleapis.com`.
5. If your company blocks creating service account keys, ask IT to allow it for this project, or to create the key for you.

## Linking a sheet

1. In the tool open Research data, then the Google Sheets tab. It shows the service account's email address.
2. In Google Sheets choose Share, add that address as a **Viewer**.
3. Paste the sheet's link into the tool and press Link sheet.

## Sheets with one row per participant (the research hub layout)

Header row (top five rows) with **Participant ID** and a **Transcript** and/or **Notes** column. Other columns that are read: Data available, Study, Name, Number, City, Call date, Call status. A column called Match check is never shown.

- **Data available** says what to read: "Transcript only", "Notes only" or "Transcript + notes". Notes on a transcript-only row are treated as processing comments and are not read as research.
- Each row names its own **Study**.
- A row is recognised by its **Participant ID**, so rows can be sorted or moved freely. Changing a transcript or notes cell reads only that part again.
- The first time a link is read, **nothing is imported**. A report shows what the sheet holds, which earlier uploads contain the same text, and capitalised words that look like names but are not in your Name column. Remove names, then press Import. Names in lowercase or in Devanagari are not found automatically, so look through the redacted copy as well.
- If you choose to withdraw earlier uploads that duplicate sheet rows, they stay in the database marked as replaced. Press **Rebuild audiences** once reading has finished.

## Sheets of call notes (one note per row)



A header row (in the top five rows) with a column called **Notes**. Other columns are read when named: Name, City, Mobile Number, Product Name, Date, Status, Type of user, Payment type, Call duration. Every visible tab with a Notes column is used.

## What happens to your data

- Names, numbers, cities and emails are removed before anything is stored. Name, City and Mobile Number columns show as `[removed]` in the tool.
- The tool never shows the original sheet. "Open the original in Google Sheets" opens Google, which enforces its own sharing rules.
- Rows you edit are read again and the old reading is withdrawn. Rows you delete are flagged, not erased, so evidence already used in answers is not lost silently.
- If more than about a third of existing rows look changed at once (for example after reformatting a column), nothing is changed until someone presses **Apply anyway**.
- Row identity follows the text of the note, so sorting or inserting rows is safe.
