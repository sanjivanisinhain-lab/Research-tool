# Security notes

What the system protects, how, and what is still your decision or risk. Written for the people who run it, not as a certification.

## What is at stake
1. **Customer research.** Quotes, call notes and transcripts, with names, numbers, emails and cities removed before storage.
2. **Accounts.** Emails and password hashes.
3. **The list of removed names** (`redaction-terms.json`). This is the one place real names are kept, so that later files are redacted consistently. It is private to the service user and is included (encrypted) in backups.
4. **The Gemini API key.**

## What leaves your server, and where it goes
Everything the AI does is done by Google's Gemini API.
| What | Sent as | Note |
|---|---|---|
| Interview and call text, notes, scripts | Redacted text (names, numbers, emails, cities already removed) | Names you did not list and the model/regex did not catch can still be in it |
| Questions and persona messages | Text, plus matching redacted evidence | |
| Design images (Assess) | The image as uploaded | Remove personal data from screenshots before uploading |
| Audio and video recordings | **As recorded**: voices, spoken names, and with screen analysis the picture | Cannot be redacted first. Each upload needs a ticked approval. The recording is deleted from the server once processed, but a copy has been sent to Google |

**Free-tier Gemini keys may let Google use submitted content to improve its products.** For real customer data use a paid (billing-enabled) key, whose data is not used for training, and confirm the current terms with Google and your own privacy/legal team. This is a policy decision, not something the software can enforce.

Prompts and AI replies are not written to the server logs. Errors log only a short message (never a key, a quote or a request body).

## Controls in place
| Area | Control |
|---|---|
| Access | Sign-in required for everything except the health check. Passwords: scrypt, 10+ characters, throttled. Sessions: random, stored hashed, HttpOnly, SameSite=Lax, 14 days, Secure over https. Admin-only research data area. Answers, plans, assessments and chats are private to their owner (admins can open any). |
| Abuse | Per-person limits on AI use and notes; per-address limits on sign-up and sign-in; small request bodies before sign-in; no-cache on API responses. |
| Web | Strict Content-Security-Policy (scripts only from the app itself and by exact hash), no framing, no outside requests (fonts are bundled), nosniff, same-origin referrer policy, HSTS over https, CSRF header on every state-changing request, generic error responses. |
| Data integrity | Quotes must exist word for word in the source; confidence is computed by code; citations are verified; unsupported claims are downgraded; evidence from contributors waits for approval. |
| Storage | Data directory and files private to the service user (0700/0600). Container runs as a non-root user with a read-only filesystem. Database snapshots are consistent. Backups are verified and can be encrypted. |
| Dependencies | Server installs its own minimal list. High-severity advisories in the spreadsheet reader were removed by replacing it. See "Known issues". |
| Audit | Uploads, approvals, rejections, role changes, password resets, study request replies and sign-ins are recorded with who did them. There is no screen to read the log yet. |

## Before other people can reach it: checklist
- [ ] `ALLOWED_EMAIL_DOMAINS` set (or you have consciously decided anyone may sign up)
- [ ] `ADMIN_SETUP_CODE` set, and you created the first account yourself
- [ ] Served over https, `COOKIE_SECURE=1`, `TRUST_PROXY=1` if behind a proxy
- [ ] Paid Gemini key, and your privacy/legal owner has agreed that redacted text and, if used, recordings may go to Google
- [ ] `BACKUP_PASSPHRASE` set, backups copied off the machine, one restore tested
- [ ] Machine disk is encrypted, firewall allows only 80/443 (and SSH from known addresses), OS updates are on
- [ ] Two people are admins, so a lost password is not a lockout

## Known issues and limits
- **Open sign-up** is the default you chose. It is the biggest exposure if the address is reachable by outsiders.
- **No second factor.** A stolen password gives access. Strong passwords and a restricted network reduce this.
- **Rate limits and sign-in throttling are in memory**: they reset when the app restarts and apply per process.
- **Redaction cannot find a name nobody listed** (the model is told to mask spoken or on-screen names, and the regexes catch numbers and emails, but nothing is perfect). Review machine transcripts, which you can read under Research data > Sources > View text.
- **Recordings are deleted after processing**, so machine transcripts and screen descriptions cannot later be checked against the original.
- **Prompt injection:** text inside uploaded research is passed to the AI. The AI has no tools and cannot act on anything; the worst case is a misleading answer, which citations and labels make visible. Contributor notes are held for approval before use.
- **Persona replies and answers are AI-written.** They are labelled, cited and checked, but a first-person voice can sound surer than a few participants justify.
- **Two moderate advisories remain** in libraries inside the Excel reader (`uuid`, `minimatch`). They need inputs this code never provides. Re-run `bun audit` in the project and in `server/` regularly and update.
- **Single server, single database file.** No automatic failover.

## If something goes wrong
- **Gemini key exposed:** revoke it at aistudio.google.com, create a new one, put it in `.env`, restart.
- **Suspected account misuse:** Research data > Team: disable the account and reset passwords; check the audit log (database table `audit_log`).
- **Suspected data exposure:** take the server off the network, keep it for investigation, restore from a verified backup on a clean machine, rotate the Gemini key and every password (`reset-password`), and involve your security and privacy owners. Remember the list of removed names and the password hashes are in the data directory.
- **Lost admin access:** `docker compose exec app bun server/cli.ts reset-password <email>` or `make-admin <email>`.
