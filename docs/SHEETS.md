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

## What the sheet needs

A header row (in the top five rows) with a column called **Notes**. Other columns are read when named: Name, City, Mobile Number, Product Name, Date, Status, Type of user, Payment type, Call duration. Every visible tab with a Notes column is used.

## What happens to your data

- Names, numbers, cities and emails are removed before anything is stored. Name, City and Mobile Number columns show as `[removed]` in the tool.
- The tool never shows the original sheet. "Open the original in Google Sheets" opens Google, which enforces its own sharing rules.
- Rows you edit are read again and the old reading is withdrawn. Rows you delete are flagged, not erased, so evidence already used in answers is not lost silently.
- If more than about a third of existing rows look changed at once (for example after reformatting a column), nothing is changed until someone presses **Apply anyway**.
- Row identity follows the text of the note, so sorting or inserting rows is safe.
